import type { Request, Response } from 'express';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import { currentActorId, currentSessionId } from '../../core/auth/authorize.js';
import { getListQuery } from '../../core/http/list-query.js';
import { ipKey, rateLimitFor } from '../../core/http/rate-limit.js';
import { sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import {
  AcceptedOut,
  ChangePasswordBody,
  ForgotPasswordBody,
  LoginBody,
  MeOut,
  ResetPasswordBody,
  SessionOut,
  TokenOut,
} from './auth.schema.js';
import { authService, type AuthServiceDeps, type ClientInfo, type SignedIn } from './auth.service.js';
import type { IdentityDeps } from './identity.routes.js';
import { IdParams } from './identity.schema.js';

/**
 * /auth (Spec P4 §2.2.3).
 *
 * The refresh token travels ONLY in an HttpOnly cookie scoped to /api/v1/auth (decision D-1.02-1): the
 * SPA is served from the API's origin (Vite proxy locally, one host on staging), so the cookie is
 * first-party, SameSite=Strict, and no script can read it. The access token is in the response body and
 * the SPA keeps it in memory only (P5 §3.4).
 *
 * POST /auth/tokens (service tokens) arrives with the first integration caller; device sign-in with the
 * device registry (CN-01, P4 §2.2.4).
 */

export const REFRESH_COOKIE = 'rupai_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === REFRESH_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
    }
  }
  return null;
}

function setRefreshCookie(res: Response, signedIn: SignedIn, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, signedIn.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: signedIn.refreshExpiresAt,
  });
}

function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
}

function clientOf(req: Request): ClientInfo {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

/** The username a sign-in names, for the per-username limit. Falls back to the IP for a bad body. */
function usernameKey(req: Request): string {
  const body: unknown = req.body;
  const u = body && typeof body === 'object' ? (body as { username?: unknown }).username : undefined;
  return typeof u === 'string' && u.trim() !== ''
    ? `username:${u.trim().toLowerCase().slice(0, 50)}`
    : ipKey(req);
}

export interface AuthModuleDeps extends IdentityDeps, Omit<AuthServiceDeps, 'config'> {
  readonly config: Pick<Config, 'auth' | 'app' | 'http'>;
}

export function authModule(deps: AuthModuleDeps): ApiModule {
  const { platform, config } = deps;
  const auth = authService(deps);
  const secure = config.auth.cookieSecure;
  const m = defineModule({
    name: 'auth',
    path: '/auth',
    tag: 'Authentication',
    platform,
    authz: deps.authz,
    accessLog: deps.accessLog,
  });

  const limit = (cls: 'authPerIp' | 'authPerUsername' | 'passwordReset', key = ipKey) => {
    const store = platform.rateLimitStore(cls);
    return rateLimitFor(cls, { enabled: config.http.rateLimitEnabled, key, ...(store ? { store } : {}) });
  };
  const signInLimits = [limit('authPerIp'), limit('authPerUsername', usernameKey)];

  m.route({
    method: 'post',
    path: '/login',
    summary: 'Sign in',
    description:
      'Returns a 15-minute access token and sets the refresh token as an HttpOnly cookie (path /api/v1/auth). ' +
      'Five failures in a row lock the account for 15 minutes (configurable). An unknown username and a wrong ' +
      'password give the same answer. When must_change_password is true, every other endpoint answers 403 ' +
      'PASSWORD_CHANGE_REQUIRED until POST /auth/password/change.',
    auth: { public: true, reason: 'Signing in is how a caller becomes authenticated.' },
    before: signInLimits,
    body: LoginBody,
    success: { status: 200, description: 'Signed in', schema: TokenOut },
    errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED'],
    handler: async (req, res) => {
      const { body } = getValidated(res, { body: LoginBody });
      const signedIn = await auth.login(body.username, body.password, clientOf(req));
      setRefreshCookie(res, signedIn, secure);
      sendOne(res, signedIn.body);
    },
  });

  m.route({
    method: 'post',
    path: '/refresh',
    summary: 'Get a new access token',
    description:
      'Uses the refresh cookie, rotates it (a new cookie is set) and returns a new access token. A refresh token ' +
      'can be used once: presenting a used one ends the whole session (theft protection). Clients must make ' +
      'one refresh call at a time (single-flight).',
    auth: {
      public: true,
      reason: 'Called when the access token has expired; the refresh cookie authenticates it.',
    },
    success: {
      status: 200,
      description: 'A new access token; the refresh cookie is rotated',
      schema: TokenOut,
    },
    errors: ['SESSION_EXPIRED'],
    handler: async (req, res) => {
      try {
        const signedIn = await auth.refresh(readRefreshCookie(req), clientOf(req));
        setRefreshCookie(res, signedIn, secure);
        sendOne(res, signedIn.body);
      } catch (err) {
        clearRefreshCookie(res, secure);
        throw err;
      }
    },
  });

  m.route({
    method: 'post',
    path: '/logout',
    summary: 'Sign out',
    description:
      'Ends the current session (its refresh-token family) and clears the cookie. Works with the access token or, ' +
      'if that has expired, with the refresh cookie alone. Always 204.',
    auth: { public: true, reason: 'Must work even when the access token has already expired.' },
    success: { status: 204, description: 'Signed out' },
    errors: [],
    handler: async (req, res) => {
      await auth.logout({
        sessionId: currentSessionIdOrNull(),
        refreshToken: readRefreshCookie(req),
      });
      clearRefreshCookie(res, secure);
      sendNoContent(res);
    },
  });

  m.route({
    method: 'post',
    path: '/logout-all',
    summary: 'Sign out everywhere',
    description: 'Ends every session of the signed-in user, on every device, including this one.',
    auth: { signedIn: true, reason: 'Acts only on the caller’s own sessions.' },
    success: { status: 204, description: 'Every session ended' },
    errors: [],
    handler: async (_req, res) => {
      await auth.logoutAll(currentActorId());
      clearRefreshCookie(res, secure);
      sendNoContent(res);
    },
  });

  m.route({
    method: 'get',
    path: '/me',
    summary: 'The signed-in user',
    description:
      'User, roles, flattened effective permissions and the resolved data scope, for permission-aware UI and ' +
      'the estate selector. Hiding a button is not authorisation: every endpoint enforces its own permission and scope.',
    auth: { signedIn: true, reason: 'Returns only the caller’s own account.' },
    success: { status: 200, description: 'The signed-in user', schema: MeOut },
    errors: [],
    handler: async (_req, res) => {
      sendOne(res, await auth.me(currentActorId(), currentSessionId()));
    },
  });

  m.route({
    method: 'get',
    path: '/sessions',
    summary: 'My active sessions',
    description: 'Sessions that can still be refreshed, most recently used first. `current` marks this one.',
    auth: { signedIn: true, reason: 'Lists only the caller’s own sessions.' },
    list: { pagination: 'page', filters: {}, sorts: [] },
    success: { status: 200, description: 'The caller’s active sessions', schema: SessionOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const page = q.page ?? { page: 1, perPage: 25 };
      const all = await auth.listSessions(currentActorId(), currentSessionId());
      const start = (page.page - 1) * page.perPage;
      sendPage(req, res, all.slice(start, start + page.perPage), { pagination: page, total: all.length });
    },
  });

  m.route({
    method: 'delete',
    path: '/sessions/:id',
    summary: 'End one of my sessions',
    description: 'For example a browser left signed in elsewhere. Another user’s session is 404.',
    auth: { signedIn: true, reason: 'Acts only on the caller’s own sessions.' },
    params: IdParams,
    success: { status: 204, description: 'Session ended' },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, { params: IdParams });
      await auth.revokeSession(currentActorId(), params.id);
      sendNoContent(res);
    },
  });

  m.route({
    method: 'post',
    path: '/password/forgot',
    summary: 'Ask for a password reset link',
    description:
      'Always 202, whether or not the address belongs to an account, so the endpoint cannot reveal who has one. ' +
      'If it does, a single-use link valid for 30 minutes is emailed: <APP_PUBLIC_URL>/reset-password#token=…',
    auth: { public: true, reason: 'Used by someone who cannot sign in.' },
    before: [limit('passwordReset')],
    body: ForgotPasswordBody,
    success: { status: 202, description: 'Accepted', schema: AcceptedOut },
    errors: [],
    handler: async (req, res) => {
      const { body } = getValidated(res, { body: ForgotPasswordBody });
      await auth.forgotPassword(body.email, clientOf(req));
      sendOne(
        res,
        { message: 'If an account uses this address, a reset link has been sent to it.' },
        { status: 202 },
      );
    },
  });

  m.route({
    method: 'post',
    path: '/password/reset',
    summary: 'Set a new password with a reset link',
    description: 'Single use. Clears any lockout and ends every session of the user.',
    auth: { public: true, reason: 'Used by someone who cannot sign in; the reset token authenticates it.' },
    before: [limit('authPerIp')],
    body: ResetPasswordBody,
    success: { status: 204, description: 'Password set; sign in with it' },
    errors: [],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: ResetPasswordBody });
      await auth.resetPassword(body.token, body.new_password);
      sendNoContent(res);
    },
  });

  m.route({
    method: 'post',
    path: '/password/change',
    summary: 'Change my password',
    description:
      'Requires the current password even in a signed-in session. Clears must_change_password. Every other ' +
      'session ends; this one stays signed in. A wrong current password is 422 on current_password.',
    auth: { signedIn: true, reason: 'Changes only the caller’s own password.' },
    before: [limit('authPerUsername', (req) => `user:${currentActorIdOr(req)}`)],
    body: ChangePasswordBody,
    success: { status: 204, description: 'Password changed' },
    errors: [],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: ChangePasswordBody });
      await auth.changePassword(
        currentActorId(),
        currentSessionId(),
        body.current_password,
        body.new_password,
      );
      sendNoContent(res);
    },
  });

  return m.build();
}

function currentSessionIdOrNull(): bigint | null {
  try {
    return currentSessionId();
  } catch {
    return null;
  }
}

function currentActorIdOr(req: Request): string {
  try {
    return currentActorId().toString();
  } catch {
    return ipKey(req);
  }
}
