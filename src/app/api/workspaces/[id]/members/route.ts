import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { pendingInvites, user, workspaceMembers, workspaces } from "@/db/schema";
import { sendEmail } from "@/server/email/resend";
import { EMAIL_FROM } from "@/server/email/magic-link";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    const rows = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        email: user.email,
        name: user.name,
      })
      .from(workspaceMembers)
      .leftJoin(user, eq(workspaceMembers.userId, user.id))
      .where(eq(workspaceMembers.workspaceId, id));
    return NextResponse.json({ members: rows });
  } catch (e) {
    return guardResponse(e);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId: inviterId } = await requireMember(id, "admin");
    const body = (await request.json().catch(() => null)) as
      | { email?: unknown; role?: unknown }
      | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body?.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }
    if (role !== "admin" && role !== "member") {
      return NextResponse.json({ error: "Role must be admin or member" }, { status: 400 });
    }

    const workspaceRows = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    const workspaceName = workspaceRows[0]?.name ?? "a workspace";

    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);

    let pending: boolean;
    if (existingUser.length > 0) {
      pending = false;
      const membership = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, id),
            eq(workspaceMembers.userId, existingUser[0].id),
          ),
        )
        .limit(1);
      if (membership.length === 0) {
        await db.insert(workspaceMembers).values({
          id: crypto.randomUUID(),
          workspaceId: id,
          userId: existingUser[0].id,
          role,
        });
      }
    } else {
      pending = true;
      await db
        .insert(pendingInvites)
        .values({
          id: crypto.randomUUID(),
          email,
          workspaceId: id,
          role,
          invitedBy: inviterId,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [pendingInvites.email, pendingInvites.workspaceId],
          set: { role, invitedBy: inviterId, createdAt: Date.now() },
        });
    }

    const { env } = getCloudflareContext();
    await sendEmail(env, {
      from: EMAIL_FROM,
      to: [email],
      subject: `You have been added to ${workspaceName} on Order Desk`,
      html: [
        '<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">',
        `<h1 style="font-size: 20px; color: #101820;">You have been added to ${workspaceName}</h1>`,
        '<p style="color: #101820;">Sign in with this email address to start managing orders.</p>',
        `<p><a href="${env.APP_URL}" style="display: inline-block; background: #91d500; color: #101820; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open Order Desk</a></p>`,
        "</div>",
      ].join(""),
    });

    return NextResponse.json({ ok: true, pending }, { status: 201 });
  } catch (e) {
    return guardResponse(e);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "owner");
    const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
    const targetUserId = typeof body?.userId === "string" ? body.userId : "";
    if (targetUserId.length === 0) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    const target = await db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, id),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);
    if (target.length === 0) {
      return NextResponse.json({ error: "No such member" }, { status: 400 });
    }
    // The owner cannot be removed, which also blocks the acting owner from
    // removing themselves.
    if (target[0].role === "owner") {
      return NextResponse.json({ error: "The owner cannot be removed" }, { status: 400 });
    }
    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, target[0].id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
