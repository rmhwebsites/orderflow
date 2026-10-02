import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromEnv, type Db } from "@/db";
import { canCreateAccount, hasAccountRoute } from "./access";
import { sendMagicLinkEmail } from "./email/magic-link";
import { claimAccessOnSignIn } from "./invites";

type AuthEnv = {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  PLATFORM_ADMIN_EMAILS?: string;
};

// The better-auth instance, with closed sign-up (platform amendment
// section 2, rules in src/server/access.ts):
// - Magic-link request: sendMagicLink delivers only when the email has a
//   route to an account (an existing user, a bootstrap platform admin, a
//   pending invite, or a Shopify roster entry). Otherwise it returns without
//   sending, and better-auth answers {status: true} exactly as it does for
//   an allowed email, so nobody can probe which addresses have access.
// - Account creation: databaseHooks.user.create.before refuses (returns
//   false) unless canCreateAccount allows the email at the moment the link
//   is opened, so a link requested while an invite existed cannot create an
//   account after the invite was withdrawn. The magic-link verify endpoint
//   then redirects with an error and creates no session.
// - Every sign-in (user.create.after for the first, session.create.after
//   for each) claims pending invites and the Shopify roster for the email.
export function createAuth(opts: {
  db: Db;
  env: AuthEnv;
  deliverMagicLink: (email: string, url: string) => Promise<void>;
}) {
  const { db, env } = opts;
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite" }),
    emailAndPassword: { enabled: false },
    // Rate-limit counters persist in D1 (rate_limit table); the in-memory
    // default resets per isolate, which is useless on Workers.
    rateLimit: { storage: "database" },
    // Cloudflare sets cf-connecting-ip on every request and overwrites any
    // client-sent value, so it is the trustworthy key for rate limiting.
    // Without it every visitor shares one global bucket per path.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [
      magicLink({
        async sendMagicLink({ email, url }) {
          if (await hasAccountRoute(db, env, email)) {
            await opts.deliverMagicLink(email, url);
          }
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await canCreateAccount(db, env, user.email))) {
              return false;
            }
          },
          after: async (user) => {
            await claimAccessOnSignIn(db, user.id, user.email);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await claimAccessOnSignIn(db, session.userId);
          },
        },
      },
    },
  });
}

// Instantiated per request: the D1 binding only exists inside a request's
// Cloudflare context, so there is no module-level auth singleton.
export function getAuth() {
  const { env } = getCloudflareContext();
  if (env.APP_URL.includes("REPLACE_ME")) {
    throw new Error("APP_URL is not configured (wrangler.jsonc still has the placeholder)");
  }
  return createAuth({
    db: getDbFromEnv(env),
    env,
    deliverMagicLink: (email, url) => sendMagicLinkEmail(env, email, url),
  });
}
