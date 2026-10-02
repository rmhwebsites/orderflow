import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { accentStyle } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { getAuth } from "@/server/auth";
import { listWorkspacesForUser } from "@/server/workspaces";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";
import { NewWorkspaceForm } from "./new-workspace-form";

// Per-viewer page: never prerender it at build time, where there is no session
// and getAuth() refuses to run without a deployed APP_URL.
export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  const rows = await listWorkspacesForUser(getDb(), session.user.id);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-ink-2">Signed in as {session.user.email}</p>
        </div>
        <ThemeToggle />
      </header>

      <section aria-labelledby="workspaces-heading" className="flex flex-col gap-3">
        <h2 id="workspaces-heading" className="font-display text-base font-semibold">
          Your workspaces
        </h2>
        {rows.length === 0 ? (
          <p className={`${ui.panel} px-4 py-5 text-sm text-ink-2`}>
            No workspaces yet. Create one below, then connect its Shopify store in Settings.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((workspace) => (
              <li key={workspace.id} style={accentStyle(workspace.accentColor)} data-accent-scope>
                <Link
                  href={`/w/${workspace.slug}`}
                  className={`${ui.panel} flex items-center gap-3 px-4 py-3 transition-colors hover:border-accent-strong`}
                >
                  <span
                    aria-hidden
                    className="grid size-9 shrink-0 place-items-center rounded-full bg-accent font-display text-sm font-semibold text-accent-ink"
                  >
                    {workspace.name.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="flex-1 font-medium">{workspace.name}</span>
                  <span className="text-xs font-medium capitalize text-ink-2">{workspace.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="new-workspace-heading" className="flex flex-col gap-3">
        <h2 id="new-workspace-heading" className="font-display text-base font-semibold">
          New workspace
        </h2>
        <NewWorkspaceForm />
      </section>
    </main>
  );
}
