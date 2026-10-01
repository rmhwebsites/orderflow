import { redirect } from "next/navigation";
import { AuthError, requireMemberBySlug } from "@/server/guard";

// Every /w/[slug] server component must call requireMemberBySlug itself;
// layouts are not an auth boundary. The cache() wrapper dedupes the work.
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let workspace: { name: string };
  try {
    ({ workspace } = await requireMemberBySlug(slug, "member"));
  } catch (e) {
    if (e instanceof AuthError) {
      redirect("/");
    }
    throw e;
  }

  return (
    <main className="mx-auto max-w-lg">
      <h1 className="font-display text-xl font-semibold">{workspace.name}</h1>
      <p className="mt-2 text-sm opacity-70">Order desk arrives in Phase 5.</p>
    </main>
  );
}
