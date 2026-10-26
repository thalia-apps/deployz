import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';

import { env } from './env.js';

// Transactional email for the control plane (invitations, membership
// changes). One narrow seam so tests can assert what would be sent without
// touching the network.

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Dev/CI default: no verified sender configured, so the mail goes to the log
 *  rather than silently nowhere. Same contract as env.ts — degraded
 *  capabilities warn, they never crash a request. */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.info(`[email] (not sent — EMAIL_FROM unset) to=${message.to} subject=${message.subject}`);
  }
}

export class SesEmailSender implements EmailSender {
  private readonly client: SESClient;

  constructor(private readonly from: string, region = env.awsRegion) {
    // The verified sending identity lives in a different AWS account from the
    // one the API Lambda runs in, so the default credential chain (the Lambda
    // execution role) is denied ses:SendEmail. When the dedicated SES keys are
    // configured, use them; otherwise fall back to the chain, which is what
    // local dev and any same-account deployment want.
    this.client = new SESClient({
      region,
      ...(env.sesAccessKeyId && env.sesSecretAccessKey
        ? {
            credentials: {
              accessKeyId: env.sesAccessKeyId,
              secretAccessKey: env.sesSecretAccessKey,
            },
          }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: `Deployz <${this.from}>`,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.body, Charset: 'UTF-8' },
            Html: { Data: renderEmailHtml(message.body), Charset: 'UTF-8' },
          },
        },
      }),
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps the plain-text body in a branded HTML layout. The logo is a PNG on
 *  the web app because many mail clients do not render SVG. */
export function renderEmailHtml(body: string): string {
  const logoUrl = `${env.webUrl}/brand/deployz/deployz-icon-512.png`;
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) =>
      escapeHtml(paragraph)
        .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#2563eb;word-break:break-all">${url}</a>`)
        .replace(/\n/g, '<br>'),
    )
    .map((paragraph) => `<p style="margin:0 0 16px">${paragraph}</p>`)
    .join('');
  return [
    '<!doctype html><html><body style="margin:0;padding:24px 16px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">',
    `<tr><td style="padding:24px 32px 0"><img src="${logoUrl}" width="32" height="32" alt="Deployz" style="display:inline-block;vertical-align:middle;border:0">`,
    '<span style="margin-left:10px;vertical-align:middle;font-size:18px;font-weight:600;color:#09090b">Deployz</span></td></tr>',
    `<tr><td style="padding:24px 32px 16px;font-size:15px;line-height:1.6;color:#09090b">${paragraphs}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
}

export function createEmailSender(): EmailSender {
  return env.emailFrom ? new SesEmailSender(env.emailFrom) : new LogEmailSender();
}

/** Sends without ever failing the caller: an unreachable mail provider must
 *  not roll back an invitation that was already written. */
export async function sendQuietly(sender: EmailSender, message: EmailMessage): Promise<void> {
  try {
    await sender.send(message);
  } catch (error) {
    console.error(`[email] delivery failed to=${message.to}`, error);
  }
}
