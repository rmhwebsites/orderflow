import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { workspaces } from "@/db/schema";
import { AuthError, requireMember } from "@/server/guard";

// Minimal shell until the full design system lands in Phase 5: a top bar with
// the workspace accent and name, content below.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = getDb();
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      accentColor: workspaces.accentColor,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) {
    redirect("/");
  }
  let allowed = false;
  try {
    await requireMember(workspace.id, "member");
    allowed = true;
  } catch (e) {
    if (!(e instanceof AuthError)) {
      throw e;
    }
  }
  if (!allowed) {
    redirect("/");
  }

  return (
    <div className="min-h-screen font-sans">
      <header className="flex items-center gap-3 border-b border-black/10 bg-white px-6 py-3">
        <span
          aria-hidden
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: workspace.accentColor }}
        />
        <span className="font-display font-semibold">{workspace.name}</span>
      </header>
      <div className="px-6 py-8">{children}</div>
    </div>
  );
}
