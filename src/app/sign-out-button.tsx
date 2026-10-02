"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/components/ui";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await authClient.signOut();
    } finally {
      router.replace("/sign-in");
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={busy} className={ui.buttonSecondary}>
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
