import { NextResponse } from "next/server";
import { getWorkspaceSettings, updateWorkspaceSettings } from "@/server/desk/settings";
import { AuthError, guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// {workspace: {name, accentColor, slug}, settings: {notificationEmails,
// poPrefix, replyTo, fromName}}
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    const payload = await getWorkspaceSettings(db, id);
    if (!payload) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json(payload);
  } catch (e) {
    return guardResponse(e);
  }
}

// Partial update of any of name, accentColor, notificationEmails, poPrefix,
// replyTo, fromName. 200 with the GET shape; 400 {error}.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "admin");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateWorkspaceSettings(db, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "ok":
        return NextResponse.json({ workspace: result.workspace, settings: result.settings });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
