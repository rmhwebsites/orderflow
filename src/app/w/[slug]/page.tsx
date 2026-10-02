import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { Desk } from "@/components/desk/desk";

// Per-viewer: reads the session.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Orders" };

// Every /w/[slug] server component must call requireMemberBySlug itself;
// layouts are not an auth boundary. The cache() wrapper dedupes the work.
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  try {
    await requireMemberBySlug(slug, "member");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  // The desk loads its own data client side (skeleton first) and reads the
  // workspace from the shell's WorkspaceProvider.
  return <Desk />;
}
