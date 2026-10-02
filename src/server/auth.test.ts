import { describe, it, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedUser, seedWorkspace } from "./desk/test-helpers";

// getAuth() reads the Cloudflare context; createAuth (tested here) does not.
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {}, ctx: {} }) }));

const { createAuth } = await import("./auth");

// Real better-auth (1.7.x) endpoints against the in-memory database: the
// magic-link request, the link itself, user creation and its hooks. Only the
// email delivery is captured instead of sent.
const BASE = "https://orderingdesk.test";
const ENV = {
  APP_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
  PLATFORM_ADMIN_EMAILS: "boss@example.com",
};

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  const sent: Array<{ email: string; url: string }> = [];
  const auth = createAuth({
    db,
    env: ENV,
    deliverMagicLink: async (email, url) => {
      sent.push({ email, url });
    },
  });
  return { db, auth, sent };
}

type Auth = Awaited<ReturnType<typeof setup>>["auth"];

async function requestLink(auth: Auth, email: string) {
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function openLink(auth: Auth, url: string) {
  return auth.handler(new Request(url, { headers: { origin: BASE } }));
}

function users(db: Db) {
  return db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).orderBy(asc(schema.user.email));
}

describe("magic-link request (closed sign-up, no enumeration)", () => {
  it("answers a stranger exactly like everyone else and sends nothing", async () => {
    const { auth, sent } = await setup();
    const stranger = await requestLink(auth, "stranger@example.com");
    const boss = await requestLink(auth, "boss@example.com");
    expect(stranger).toEqual({ status: 200, body: { status: true } });
    expect(stranger).toEqual(boss);
    expect(sent.map((s) => s.email)).toEqual(["boss@example.com"]);
  });

  it("sends a link to an existing user, an invited email and a tagged Shopify customer", async () => {
    const { db, auth, sent } = await setup();
    await seedUser(db, "u_old", "old@example.com");
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_old",
      createdAt: 1,
    });
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "buyer@example.com",
      role: "manager",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    for (const email of ["old@example.com", "Crew@example.com", "buyer@example.com"]) {
      expect((await requestLink(auth, email)).body).toEqual({ status: true });
    }
    expect(sent.map((s) => s.email.toLowerCase())).toEqual([
      "old@example.com",
      "crew@example.com",
      "buyer@example.com",
    ]);
  });
});

describe("account creation", () => {
  it("creates an invited person's account and claims the invite as a manual membership", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_x",
      createdAt: 1,
    });
    await requestLink(auth, "crew@example.com");
    const response = await openLink(auth, sent[0].url);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie") ?? "").toContain("session_token");

    const [created] = await db.select().from(schema.user).where(eq(schema.user.email, "crew@example.com"));
    expect(created).toBeDefined();
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, created.id));
    expect(memberships).toEqual([{ role: "staff", source: "manual" }]);
    expect(await db.select().from(schema.pendingInvites)).toEqual([]);
  });

  it("creates a tagged Shopify customer's account as a shopify membership", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "buyer@example.com",
      role: "manager",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    await requestLink(auth, "buyer@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ role: "manager", source: "shopify" }]);
  });

  it("refuses to create the account when the route to it is gone by the time the link is opened", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_x",
      createdAt: 1,
    });
    await requestLink(auth, "crew@example.com");
    // The manager withdraws the invite before the link is opened.
    await db.delete(schema.pendingInvites);

    const response = await openLink(auth, sent[0].url);
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain("error=");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await users(db)).toEqual([]);
    expect(await db.select().from(schema.session)).toEqual([]);
  });

  it("claims access granted after the first sign-up at the next sign-in", async () => {
    const { db, auth, sent } = await setup();
    await seedUser(db, "u_old", "old@example.com");
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "old@example.com",
      role: "staff",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    await requestLink(auth, "old@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ userId: schema.workspaceMembers.userId, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ userId: "u_old", source: "shopify" }]);
  });
});
