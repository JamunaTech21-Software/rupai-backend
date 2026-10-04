import { randomBytes } from 'node:crypto';

import type { Logger } from 'pino';
import type { z } from 'zod';

import type { Config } from '../../config/env.js';
import type { PermissionResolver } from '../../core/auth/authorize.js';
import { hashPassword, needsRehash, verifyPassword } from '../../core/auth/password.js';
import type { RevokeReason, SessionStore } from '../../core/auth/sessions.js';
import { scopeView } from '../../core/scope/scope.js';
import { hashOpaqueToken, newOpaqueToken, type TokenSigner } from '../../core/auth/tokens.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import { getLogger } from '../../core/logging/logger.js';
import type { Mailer } from '../../core/mail/mailer.js';
import type { MeOut, SessionOut, TokenOut } from './auth.schema.js';
import * as authRepo from './auth.repository.js';
import * as identityRepo from './identity.repository.js';
import { toUserOut } from './users.service.js';

/**
 * Authentication and sessions (Spec P4 §2.2, P1 §12.4).
 *
 *   - Sign-in issues a 15-minute access token (identity only) and a refresh token. One sign-in is one
 *     session, and the session is the refresh-token family.
 *   - Refresh tokens rotate on every use. Presenting a token that was already used is treated as theft:
 *     the whole session is revoked and the event is logged as a security incident (P4 §2.2.1).
 *   - Failed sign-ins are counted per user; at the threshold the account locks for a while. Per source
 *     address, the auth rate limit classes apply (P4 §2.9).
 *   - A wrong password and an unknown username give the same answer, in about the same time.
 *   - Forgot-password always answers 202, whether or not the address exists.
 *   - Every authentication event is logged with `event: auth.*`. They move to access_log with P1.05.
 */

type TokenOutT = z.infer<typeof TokenOut>;

export interface ClientInfo {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface SignedIn {
  readonly body: TokenOutT;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly sessions: SessionStore;
  readonly signer: TokenSigner;
  readonly authz: PermissionResolver;
  readonly mailer: Mailer;
  readonly config: Pick<Config, 'auth' | 'app'>;
  readonly logger: Logger;
}

const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 'The username or password is incorrect.');

const sessionExpired = () => new AppError('SESSION_EXPIRED', 'Your session has ended. Sign in again.');

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function authService(deps: AuthServiceDeps) {
  const { db, sessions, signer, config } = deps;

  const event = (level: 'info' | 'warn', name: string, fields: Record<string, unknown> = {}) => {
    getLogger(deps.logger)[level]({ event: name, ...fields }, name);
  };

  // Verifying against a throwaway hash when the username does not exist keeps the response time of an
  // unknown username close to that of a wrong password, so timing does not reveal which usernames exist.
  let dummyHash: Promise<string> | undefined;
  const burnTime = async (password: string) => {
    dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
    await verifyPassword(await dummyHash, password);
  };

  async function issueRefreshToken(tx: Tx, sessionId: bigint, sessionExpiresAt: Date) {
    const token = newOpaqueToken();
    const expiresAt = new Date(
      Math.min(Date.now() + config.auth.refreshTokenSeconds * 1000, sessionExpiresAt.getTime()),
    );
    await authRepo.insertRefreshToken(tx, { sessionId, tokenHash: hashOpaqueToken(token), expiresAt });
    return { token, expiresAt };
  }

  function tokenBody(
    user: { id: bigint; username: string },
    sessionId: bigint,
    mustChangePassword: boolean,
  ): TokenOutT {
    const access = signer.sign(user.id, sessionId);
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: signer.ttlSeconds,
      expires_at: access.expiresAt.toISOString(),
      session_id: sessionId.toString(),
      must_change_password: mustChangePassword,
      user: { id: user.id.toString(), username: user.username },
    };
  }

  async function revokeAndPublish(work: (tx: Tx) => Promise<bigint[]>): Promise<bigint[]> {
    const ids = await withTransaction(db, work);
    await sessions.markRevoked(ids);
    return ids;
  }

  return {
    async login(username: string, password: string, client: ClientInfo): Promise<SignedIn> {
      const user = await authRepo.findUserForLogin(db, username);
      if (!user) {
        await burnTime(password);
        event('info', 'auth.login_failed', { username, ip: client.ip, reason: 'unknown_user' });
        throw invalidCredentials();
      }
      const ok = await verifyPassword(user.passwordHash, password);
      const locked = user.lockedUntil !== null && user.lockedUntil > new Date();

      if (!ok) {
        // A locked or disabled account does not count further failures: there is nothing more to lock.
        if (!locked && user.status === 'active') {
          const lockedUntil = await withTransaction(db, (tx) =>
            authRepo.recordFailedAttempt(
              tx,
              user.id,
              config.auth.lockoutThreshold,
              config.auth.lockoutSeconds,
            ),
          );
          if (lockedUntil) {
            event('warn', 'auth.account_locked', {
              user_id: user.id,
              ip: client.ip,
              locked_until: lockedUntil,
            });
          }
        }
        event('info', 'auth.login_failed', { user_id: user.id, ip: client.ip, reason: 'bad_password' });
        throw invalidCredentials();
      }

      // Only someone who knows the password learns that the account is locked or disabled.
      if (locked) {
        const retryAfter = Math.max(1, Math.ceil(((user.lockedUntil?.getTime() ?? 0) - Date.now()) / 1000));
        event('info', 'auth.login_failed', { user_id: user.id, ip: client.ip, reason: 'locked' });
        throw new AppError('ACCOUNT_LOCKED', 'Too many failed sign-ins. The account is locked for now.', [
          {
            code: 'ACCOUNT_LOCKED',
            message: `Try again in ${String(Math.ceil(retryAfter / 60))} minutes, or ask an administrator.`,
            context: { locked_until: iso(user.lockedUntil), retry_after_seconds: retryAfter },
          },
        ]);
      }
      if (user.status !== 'active') {
        event('info', 'auth.login_failed', { user_id: user.id, ip: client.ip, reason: 'disabled' });
        throw new AppError('ACCOUNT_LOCKED', 'This account is disabled.', [
          { code: 'ACCOUNT_DISABLED', message: 'Ask an administrator to re-enable it.' },
        ]);
      }

      // Parameters strengthened since this hash was made: upgrade it now, while the plain text is known.
      const rehashed = needsRehash(user.passwordHash) ? await hashPassword(password) : null;
      const now = new Date();
      const sessionExpiresAt = new Date(now.getTime() + config.auth.sessionMaxSeconds * 1000);
      const { sessionId, refresh } = await withTransaction(db, async (tx) => {
        await authRepo.recordSuccessfulLogin(tx, user.id, now, rehashed);
        const session = await authRepo.insertSession(tx, {
          userId: user.id,
          expiresAt: sessionExpiresAt,
          ipAddress: client.ip,
          userAgent: client.userAgent?.slice(0, 255) ?? null,
        });
        return { sessionId: session.id, refresh: await issueRefreshToken(tx, session.id, sessionExpiresAt) };
      });
      event('info', 'auth.login_succeeded', { user_id: user.id, session_id: sessionId, ip: client.ip });
      return {
        body: tokenBody(user, sessionId, user.mustChangePassword),
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt,
      };
    },

    async refresh(refreshToken: string | null, client: ClientInfo): Promise<SignedIn> {
      if (!refreshToken) throw sessionExpired();
      const tokenHash = hashOpaqueToken(refreshToken);
      const outcome = await withTransaction(db, async (tx) => {
        const row = await authRepo.lockRefreshToken(tx, tokenHash);
        if (!row) return { kind: 'invalid' as const };
        const sessionId = row.session_id;
        if (Number(row.used) === 1) {
          // Reuse of a rotated token: someone else holds a copy. End the whole family (P4 §2.2.1).
          const revoked = await sessions.revoke(tx, sessionId, 'refresh_reuse');
          return { kind: 'reuse' as const, sessionId, userId: row.user_id, revoked };
        }
        if (Number(row.token_live) !== 1 || Number(row.session_live) !== 1 || Number(row.user_active) !== 1) {
          return { kind: 'invalid' as const };
        }
        await authRepo.markRefreshTokenUsed(tx, row.id);
        await authRepo.touchSession(tx, sessionId, client.ip);
        const next = await issueRefreshToken(tx, sessionId, row.session_expires_at);
        return {
          kind: 'ok' as const,
          sessionId,
          user: { id: row.user_id, username: row.username },
          mustChangePassword: Boolean(Number(row.must_change_password)),
          next,
        };
      });

      if (outcome.kind === 'reuse') {
        await sessions.markRevoked(outcome.revoked);
        event('warn', 'auth.refresh_reuse', {
          user_id: outcome.userId,
          session_id: outcome.sessionId,
          ip: client.ip,
          security_incident: true,
        });
        throw sessionExpired();
      }
      if (outcome.kind === 'invalid') throw sessionExpired();
      event('info', 'auth.token_refreshed', { user_id: outcome.user.id, session_id: outcome.sessionId });
      return {
        body: tokenBody(outcome.user, outcome.sessionId, outcome.mustChangePassword),
        refreshToken: outcome.next.token,
        refreshExpiresAt: outcome.next.expiresAt,
      };
    },

    /** Ends the session named by the access token, or else by the refresh cookie. Always succeeds. */
    async logout(input: { sessionId: bigint | null; refreshToken: string | null }): Promise<void> {
      const sessionId =
        input.sessionId ??
        (input.refreshToken
          ? await authRepo.findSessionIdByRefreshToken(db, hashOpaqueToken(input.refreshToken))
          : null);
      if (sessionId === null) return;
      const revoked = await revokeAndPublish((tx) => sessions.revoke(tx, sessionId, 'logout'));
      if (revoked.length > 0) event('info', 'auth.logout', { session_id: sessionId });
    },

    async logoutAll(userId: bigint): Promise<number> {
      const revoked = await revokeAndPublish((tx) => sessions.revokeForUser(tx, userId, 'logout_all'));
      event('info', 'auth.logout_all', { user_id: userId, sessions: revoked.length });
      return revoked.length;
    },

    async me(userId: bigint, sessionId: bigint | null): Promise<z.infer<typeof MeOut>> {
      const user = await identityRepo.findUser(db, userId);
      if (!user) throw Errors.notFound('User not found.');
      const [permissions, scope] = await Promise.all([
        deps.authz.permissionsOf(userId),
        deps.authz.scopeOf(userId),
      ]);
      return {
        user: toUserOut(user),
        permissions: [...permissions].sort(),
        scope: scopeView(scope),
        session_id: sessionId?.toString() ?? null,
        must_change_password: user.mustChangePassword,
      };
    },

    async listSessions(
      userId: bigint,
      currentSessionId: bigint | null,
    ): Promise<z.infer<typeof SessionOut>[]> {
      const idleSince = new Date(Date.now() - config.auth.refreshTokenSeconds * 1000);
      const rows = await authRepo.listLiveSessions(db, userId, idleSince);
      return rows.map((s) => ({
        id: s.id.toString(),
        created_at: s.createdAt.toISOString(),
        last_used_at: s.lastUsedAt.toISOString(),
        expires_at: s.expiresAt.toISOString(),
        ip_address: s.ipAddress,
        user_agent: s.userAgent,
        current: s.id === currentSessionId,
      }));
    },

    /** Revokes one of the caller's own sessions. Someone else's, or an ended one, is 404. */
    async revokeSession(userId: bigint, sessionId: bigint): Promise<void> {
      const revoked = await revokeAndPublish(async (tx) => {
        const s = await authRepo.findSession(tx, sessionId);
        if (s?.userId !== userId || s.revokedAt !== null) throw Errors.notFound('Session not found.');
        return sessions.revoke(tx, sessionId, 'session_revoked');
      });
      if (revoked.length > 0)
        event('info', 'auth.session_revoked', { user_id: userId, session_id: sessionId });
    },

    /**
     * Requires the current password even in a signed-in session (P4 §2.2.3). Ends every OTHER session;
     * the one in use stays signed in. Clears must_change_password.
     */
    async changePassword(
      userId: bigint,
      currentSessionId: bigint | null,
      currentPassword: string,
      newPassword: string,
    ): Promise<void> {
      const user = await authRepo.findPasswordHash(db, userId);
      if (!user) throw Errors.notFound('User not found.');
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        event('info', 'auth.password_change_failed', { user_id: userId });
        // 422, not 401: a wrong current password must not look like an expired session to the client.
        throw Errors.validation([
          {
            field: 'current_password',
            code: 'VALIDATION_FAILED',
            message: 'The current password is incorrect.',
          },
        ]);
      }
      if (await verifyPassword(user.passwordHash, newPassword)) {
        throw Errors.validation([
          {
            field: 'new_password',
            code: 'VALIDATION_FAILED',
            message: 'Choose a password you are not using now.',
          },
        ]);
      }
      const passwordHash = await hashPassword(newPassword);
      const revoked = await withTransaction(db, async (tx) => {
        await authRepo.setPassword(tx, userId, passwordHash);
        return sessions.revokeForUser(
          tx,
          userId,
          'password_changed',
          currentSessionId !== null ? { except: currentSessionId } : {},
        );
      });
      await sessions.markRevoked(revoked);
      if (currentSessionId !== null) await sessions.forget([currentSessionId]);
      event('info', 'auth.password_changed', { user_id: userId, other_sessions_ended: revoked.length });
    },

    /** Always resolves the same way, so the endpoint cannot tell anyone which addresses exist. */
    async forgotPassword(email: string, client: ClientInfo): Promise<void> {
      const user = await authRepo.findActiveUserByEmail(db, email);
      if (!user?.email) {
        event('info', 'auth.password_reset_requested', { ip: client.ip, matched: false });
        return;
      }
      const token = newOpaqueToken();
      const expiresAt = new Date(Date.now() + config.auth.passwordResetSeconds * 1000);
      await withTransaction(db, (tx) =>
        authRepo.replaceResetToken(tx, {
          userId: user.id,
          tokenHash: hashOpaqueToken(token),
          expiresAt,
          requestedIp: client.ip,
        }),
      );
      event('info', 'auth.password_reset_requested', { user_id: user.id, ip: client.ip, matched: true });

      // The token travels in the URL fragment: browsers never send a fragment to a server, so it stays
      // out of access logs and Referer headers.
      const link = `${config.app.publicUrl}/reset-password#token=${token}`;
      const minutes = String(Math.round(config.auth.passwordResetSeconds / 60));
      // Not awaited: the response must not wait on (or reveal) mail delivery.
      deps.mailer
        .send({
          to: user.email,
          subject: 'Reset your RupAI password',
          text: [
            `Hello ${user.username},`,
            '',
            'Someone asked to reset the password of your RupAI account. If it was you, open this link',
            `within ${minutes} minutes and choose a new password:`,
            '',
            link,
            '',
            'If it was not you, ignore this email. Your password has not changed.',
          ].join('\n'),
        })
        .catch((err: unknown) => {
          getLogger(deps.logger).error({ err, user_id: user.id }, 'password reset email could not be sent');
        });
    },

    /** Single use. Sets the password, clears any lockout and ends every session of the user. */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const passwordHash = await hashPassword(newPassword);
      const outcome = await withTransaction(db, async (tx) => {
        const row = await authRepo.lockResetToken(tx, hashOpaqueToken(token));
        if (!row || Number(row.usable) !== 1) return null;
        const userId = row.user_id;
        await authRepo.markResetTokenUsed(tx, row.id);
        await authRepo.setPassword(tx, userId, passwordHash);
        const revoked = await sessions.revokeForUser(tx, userId, 'password_reset' satisfies RevokeReason);
        return { userId, revoked };
      });
      if (!outcome) {
        throw Errors.validation([
          {
            field: 'token',
            code: 'VALIDATION_FAILED',
            message: 'This reset link is invalid, already used or expired. Ask for a new one.',
          },
        ]);
      }
      await sessions.markRevoked(outcome.revoked);
      event('info', 'auth.password_reset', {
        user_id: outcome.userId,
        sessions_ended: outcome.revoked.length,
      });
    },
  };
}

export type AuthService = ReturnType<typeof authService>;
