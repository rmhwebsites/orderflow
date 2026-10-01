import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromEnv } from "@/db";
import { sendMagicLinkEmail } from "./email/magic-link";
import { claimPendingInvites } from "./invites";

// Instantiated per request: the D1 binding only exists inside a request's
// Cloudflare context, so there is no module-level auth singleton.
export function getAuth() {
  const { env } = getCloudflareContext();
  const db = getDbFromEnv(env);
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite" }),
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        async sendMagicLink({ email, url }) {
          await sendMagicLinkEmail(env, email, url);
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await claimPendingInvites(db, user.id, user.email);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await claimPendingInvites(db, session.userId);
          },
        },
      },
    },
  });
}
