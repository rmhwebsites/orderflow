"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "sending") {
      return;
    }
    setPhase("sending");
    setErrorMessage("");
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
    });
    if (error) {
      setPhase("error");
      setErrorMessage(error.message ?? "Could not send the sign-in link.");
    } else {
      setPhase("sent");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6 font-sans">
      <div>
        <h1 className="font-display text-2xl font-semibold">Order Desk</h1>
        <p className="mt-1 text-sm opacity-70">Sign in with your email address.</p>
      </div>
      {phase === "sent" ? (
        <div className="rounded-lg border border-black/10 bg-white p-4">
          <p className="font-medium">Check your email</p>
          <p className="mt-1 text-sm opacity-70">
            We sent a sign-in link to {email}. It expires in 5 minutes.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="rounded-lg border border-black/15 bg-white px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={phase === "sending"}
            className="rounded-lg bg-[var(--accent)] px-3 py-2 font-medium text-[var(--ink)] disabled:opacity-50"
          >
            {phase === "sending" ? "Sending" : "Send sign-in link"}
          </button>
          {phase === "error" ? (
            <p className="text-sm text-red-600">{errorMessage}</p>
          ) : null}
        </form>
      )}
    </main>
  );
}
