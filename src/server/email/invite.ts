import { APP_NAME } from "../../lib/brand";
import { escapeHtml, sanitizeSubject } from "./escape";
import { defaultFrom, sendEmail } from "./send";

function inviteHtml(heading: string, body: string, appUrl: string): string {
  return [
    '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">',
    `<h1 style="font-size: 20px; color: #101820;">${heading}</h1>`,
    `<p style="color: #101820;">${body}</p>`,
    `<p><a href="${escapeHtml(appUrl)}" style="display: inline-block; background: #91d500; color: #101820; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open ${escapeHtml(APP_NAME)}</a></p>`,
    "</div>",
  ].join("");
}

// Sent when a manager or platform admin adds someone to a workspace (an
// existing user, or a pending invite). Workspace names are user input:
// entity-escaped in the HTML, control-stripped in the subject.
export async function sendWorkspaceInviteEmail(
  env: CloudflareEnv,
  to: string,
  workspaceName: string,
): Promise<void> {
  const safeName = escapeHtml(workspaceName);
  await sendEmail(env, {
    from: defaultFrom(env),
    to: [to],
    subject: `You have been added to ${sanitizeSubject(workspaceName)} on ${APP_NAME}`,
    html: inviteHtml(
      `You have been added to ${safeName}`,
      "Sign in with this email address to start managing orders.",
      env.APP_URL,
    ),
  });
}

// Sent when a platform admin promotes someone (an existing user, or a
// pending platform-admin invite).
export async function sendPlatformAdminInviteEmail(env: CloudflareEnv, to: string): Promise<void> {
  await sendEmail(env, {
    from: defaultFrom(env),
    to: [to],
    subject: `You are now a platform admin on ${APP_NAME}`,
    html: inviteHtml(
      `You are now a platform admin on ${escapeHtml(APP_NAME)}`,
      "Sign in with this email address to manage every workspace.",
      env.APP_URL,
    ),
  });
}
