import { redirect } from "next/navigation";
import { AuthError, requireMemberBySlug } from "@/server/guard";

// Minimal shell until the full design system lands in Phase 5: a top bar with
// the workspace accent and name, content below.
//
// Every /w/[slug] server component must call requireMemberBySlug itself;
// layouts are not an auth boundary. The cache() wrapper dedupes the work.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let workspace: { name: string; accentColor: string };
  try {
    ({ workspace } = await requireMemberBySlug(slug, "member"));
  } catch (e) {
    if (e instanceof AuthError) {
      redirect("/");
    }
    throw e;
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
