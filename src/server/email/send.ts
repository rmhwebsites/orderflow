import { APP_NAME } from "../../lib/brand";

// Email driver: Cloudflare Email Service send binding (wrangler.jsonc
// "send_email", bound as EMAIL). All app email goes through sendEmail so the
// localhost fallback applies everywhere: in local dev the binding cannot
// really deliver, so the recipient, subject, and first link are logged and
// flows like magic-link sign-in stay testable from the dev server log.

// Default sender for app email until per-workspace senders arrive. The
// impactrentals.store domain MUST be onboarded in Cloudflare Email Service
// (Workers Paid) before production email can send from it.
export const DEFAULT_FROM = `${APP_NAME} <orders@orderingdesk.com>`;

// The sender actually used: EMAIL_FROM (wrangler.jsonc vars) when set, else
// DEFAULT_FROM. Whatever domain it names must be onboarded for Email Sending
// in the same Cloudflare account as this Worker, or every send is refused.
export function defaultFrom(env: CloudflareEnv): string {
  return env.EMAIL_FROM || DEFAULT_FROM;
}

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

// "Display Name <addr>" becomes the structured EmailAddress the binding
// accepts; a bare address passes through as a string.
function parseAddress(value: string): string | { name: string; email: string } {
  const match = value.match(/^(.+)<([^<>]+)>\s*$/);
  if (match && match[1].trim().length > 0) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return value;
}

// Email Service attachments require a MIME type; our options carry only
// filename + content (base64), so the type is inferred from the extension.
// Phase 7 sends PDFs; extend the map when a template attaches something new.
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  csv: "text/csv",
};

function attachmentType(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Sends an email through the Cloudflare Email Service binding.
 *
 * Convention for ALL templates (current and Phase 6/7, which interpolate
 * customer and vendor data), applied at the call site because sendEmail
 * cannot tell markup from data:
 * - every dynamic value interpolated into `opts.html` MUST pass through
 *   escapeHtml from "./escape";
 * - every dynamic value interpolated into `opts.subject` MUST pass through
 *   sanitizeSubject from "./escape", never escapeHtml (subjects are plain
 *   text, so entity encoding would show literally).
 *
 * Dev fallback: when APP_URL points at localhost the email is logged instead
 * of sent (the binding does not deliver from local dev anyway). Outside
 * localhost the EMAIL binding is required, so a misconfigured deployment
 * fails loudly instead of silently dropping email.
 */
export async function sendEmail(
  env: CloudflareEnv,
  opts: SendEmailOptions,
): Promise<{ id: string }> {
  if (env.APP_URL.startsWith("http://localhost")) {
    console.log(
      "[email-fallback]",
      JSON.stringify({ to: opts.to, subject: opts.subject, url: firstUrlIn(opts.html) }),
    );
    return { id: "dev-fallback" };
  }
  if (!env.EMAIL) {
    throw new Error("Email sending is not configured (EMAIL binding missing)");
  }
  const message: EmailMessageBuilder = {
    from: parseAddress(opts.from),
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.cc ? { cc: opts.cc } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.attachments
      ? {
          attachments: opts.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content,
            type: attachmentType(attachment.filename),
            disposition: "attachment" as const,
          })),
        }
      : {}),
  };
  const result = await env.EMAIL.send(message);
  return { id: result.messageId };
}
