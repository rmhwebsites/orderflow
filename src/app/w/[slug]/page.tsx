import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { workspaces } from "@/db/schema";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = getDb();
  const rows = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  const name = rows[0]?.name ?? slug;

  return (
    <main className="mx-auto max-w-lg">
      <h1 className="font-display text-xl font-semibold">{name}</h1>
      <p className="mt-2 text-sm opacity-70">Order desk arrives in Phase 5.</p>
    </main>
  );
}
