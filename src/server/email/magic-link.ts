import { sendEmail } from "./resend";

// Placeholder sender until a real domain is verified with Resend; the brand
// polish pass in Phase 6 replaces the template. Kept in one place so swapping
// the sender later is a one-line change.
export const EMAIL_FROM = "Order Desk <onboarding@resend.dev>";

export async function sendMagicLinkEmail(
  env: CloudflareEnv,
  email: string,
  url: string,
): Promise<void> {
  await sendEmail(env, {
    from: EMAIL_FROM,
    to: [email],
    subject: "Sign in to Order Desk",
    html: [
      '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">',
      '<h1 style="font-size: 20px; color: #101820;">Sign in to Order Desk</h1>',
      '<p style="color: #101820;">Click the button below to sign in. This link expires in 5 minutes.</p>',
      `<p><a href="${url}" style="display: inline-block; background: #91d500; color: #101820; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Sign in</a></p>`,
      '<p style="color: #6b7280; font-size: 13px;">If you did not request this email, you can safely ignore it.</p>',
      "</div>",
    ].join(""),
  });
}
