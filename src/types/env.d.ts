// Merges with the wrangler-generated CloudflareEnv (cloudflare-env.d.ts) so the
// secret keys are always typed, even when a developer has no local .dev.vars.
// Email sends through the EMAIL binding (Cloudflare Email Service), which
// cf-typegen types from wrangler.jsonc; no entry is needed here.
interface CloudflareEnv {
  BETTER_AUTH_SECRET: string;
  ENCRYPTION_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  CRON_SECRET: string;
  APP_URL: string;
}
