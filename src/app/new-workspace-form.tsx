"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || name.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      setName("");
      router.refresh();
    } else {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setErrorMessage(data?.error ?? "Could not create the workspace.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New workspace name"
          className="flex-1 rounded-lg border border-black/15 bg-white px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--ink)] disabled:opacity-50"
        >
          {busy ? "Creating" : "Create"}
        </button>
      </div>
      {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
    </form>
  );
}
