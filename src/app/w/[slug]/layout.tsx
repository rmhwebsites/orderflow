import { notFound, redirect } from "next/navigation";
import { accentStyle } from "@/lib/accent";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { SyncBanner } from "@/components/shell/sync-banner";
import { TopBar } from "@/components/shell/top-bar";
import { WorkspaceProvider } from "@/components/shell/workspace-provider";
import { ToastProvider } from "@/components/toasts";

// Per-viewer: reads the session.
export const dynamic = "force-dynamic";

// The workspace shell: accent scope, providers, top bar, sync banner.
//
// Every /w/[slug] server component must call requireMemberBySlug itself;
// layouts are not an auth boundary. The cache() wrapper dedupes the work.
// Signed out goes to sign-in; a missing workspace, a non-member and an
// under-ranked member all get the same 404.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let guarded: Awaited<ReturnType<typeof requireMemberBySlug>>;
  try {
    guarded = await requireMemberBySlug(slug, "staff");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  const { workspace, role, userId } = guarded;

  return (
    // The accent scope: the four accent variables come from the workspace's
    // validated #rrggbb accent (src/lib/accent.ts); globals.css derives the
    // per-theme strong accent and focus ring from them under this attribute.
    <div data-accent-scope style={accentStyle(workspace.accentColor)} className="min-h-dvh">
      <ToastProvider>
        <WorkspaceProvider
          workspace={{ id: workspace.id, slug: workspace.slug, name: workspace.name }}
          role={role}
          userId={userId}
        >
          {/* Made inert while the order drawer is open (it renders into
              #workspace-overlays, inside the accent scope). */}
          <div id="workspace-main" className="flex min-h-dvh flex-col">
            <TopBar name={workspace.name} logoUrl={workspace.logoUrl} />
            <SyncBanner />
            <div className="flex-1">{children}</div>
          </div>
          <div id="workspace-overlays" />
        </WorkspaceProvider>
      </ToastProvider>
    </div>
  );
}
