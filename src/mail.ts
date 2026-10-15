import { escapeHtml } from './adapters/tinylaunch.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type Mailer = (m: Mail) => Promise<void>;

/** Resend over HTTPS. Without a key (local development) the message goes to stderr instead. */
export function resendMailer(apiKey: string | undefined, from: string, f: typeof fetch = fetch): Mailer {
  return async (m) => {
    if (!apiKey) {
      process.stderr.write(`[mail:dev] to=${m.to} subject=${m.subject}\n${m.text}\n`);
      return;
    }
    const res = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

function layout(heading: string, body: string, cta: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17181a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:14px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 20px;font-weight:700;font-size:15px;letter-spacing:.2px">SubmitFleet</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">${escapeHtml(heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3d4046">${body}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#0b6e4f;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:9px">${escapeHtml(cta.label)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6f76">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function signupMail(to: string, url: string): Mail {
  return {
    to,
    subject: 'Confirm your SubmitFleet account',
    text: `Confirm your email to finish creating your SubmitFleet account:\n\n${url}\n\nThe link works once and expires in 20 minutes. If you did not sign up, ignore this email.`,
    html: layout('Confirm your email', 'One click finishes creating your SubmitFleet account.', { label: 'Confirm and sign in', url }, 'The link works once and expires in 20 minutes. If you did not sign up, you can ignore this email.'),
  };
}

export function loginMail(to: string, url: string, existing: boolean): Mail {
  return {
    to,
    subject: 'Your SubmitFleet sign-in link',
    text: `${existing ? 'Sign in to SubmitFleet' : 'Create your SubmitFleet account and sign in'}:\n\n${url}\n\nThe link works once and expires in 20 minutes. If you did not ask for it, ignore this email.`,
    html: layout(existing ? 'Sign in to SubmitFleet' : 'Welcome to SubmitFleet', existing ? 'Use this link to sign in. You can add a passkey afterwards for one-tap sign-in.' : 'Use this link to create your account and sign in.', { label: 'Sign in', url }, 'The link works once and expires in 20 minutes. If you did not ask for it, you can ignore this email.'),
  };
}
