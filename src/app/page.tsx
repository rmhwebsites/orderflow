import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAuth } from "@/server/auth";
import { listWorkspacesForUser } from "@/server/workspaces";
import { NewWorkspaceForm } from "./new-workspace-form";

export default async function Home() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  const rows = await listWorkspacesForUser(getDb(), session.user.id);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-8 px-6 py-12 font-sans">
      <div>
        <h1 className="font-display text-2xl font-semibold">Order Desk</h1>
        <p className="mt-1 text-sm opacity-70">Signed in as {session.user.email}</p>
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          Your workspaces
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm opacity-70">
            No workspaces yet. Create one below to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/w/${workspace.slug}`}
                  className="flex items-center gap-3 rounded-lg border border-black/10 bg-white px-4 py-3 hover:border-[var(--accent)]"
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: workspace.accentColor }}
                  />
                  <span className="flex-1 font-medium">{workspace.name}</span>
                  <span className="text-xs uppercase tracking-wide opacity-60">
                    {workspace.role}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          New workspace
        </h2>
        <NewWorkspaceForm />
      </section>
    </main>
  );
}
