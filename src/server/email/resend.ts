// Thin Resend REST client. All app email goes through sendEmail so the dev
// fallback (no real key available locally) applies everywhere: instead of
// calling Resend it logs the recipient, subject, and first link so flows like
// magic-link sign-in stay testable from the dev server log.

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const PLACEHOLDER_KEY = "re_xxx";

export interface SendEmailOptions {
  from: string;
  to: string[];
  subject: string;
  html: string;
  cc?: string[];
  replyTo?: string;
  attachments?: { filename: string; content: string }[];
}

function firstUrlIn(html: string): string | undefined {
  const match = html.match(/https?:\/\/[^\s"'<>]+/);
  return match ? match[0] : undefined;
}

export async function sendEmail(
  env: CloudflareEnv,
  opts: SendEmailOptions,
): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY === PLACEHOLDER_KEY) {
    console.log(
      "[email-fallback]",
      JSON.stringify({ to: opts.to, subject: opts.subject, url: firstUrlIn(opts.html) }),
    );
    return { id: "dev-fallback" };
  }
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      cc: opts.cc,
      reply_to: opts.replyTo,
      attachments: opts.attachments,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend request failed (${response.status}): ${text}`);
  }
  return (await response.json()) as { id: string };
}
