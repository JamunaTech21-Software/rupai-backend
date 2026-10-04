import nodemailer from 'nodemailer';
import type { Logger } from 'pino';

import type { Config } from '../../config/env.js';

/**
 * Outgoing email. P1.02 sends password reset links. Notifications (P1.16) will send through the same
 * interface, from a job rather than a request.
 *
 *   SMTP_HOST set   → SMTP (locally Mailpit at 127.0.0.1:1025, web UI http://localhost:8025)
 *   SMTP_HOST unset → the message is written to the log (development and tests only; production
 *                     refuses to start without SMTP_HOST)
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(config: Pick<Config, 'mail' | 'isProduction'>, logger: Logger): Mailer {
  const { smtp, from } = config.mail;
  if (!smtp) {
    if (config.isProduction) throw new Error('SMTP is required in production');
    return {
      send(message) {
        // Outside production only: lets a developer follow a reset link without a mail server.
        logger.warn({ mail: message }, 'SMTP_HOST not set: email written to the log instead of sent');
        return Promise.resolve();
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** Keeps messages in memory. Tests only. */
export function memoryMailer(): Mailer & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}
