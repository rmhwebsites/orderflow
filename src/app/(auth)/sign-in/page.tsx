"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { APP_NAME } from "@/lib/brand";
import { ui } from "@/components/ui";

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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 sm:px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
        <p className="mt-1 text-sm text-ink-2">Sign in with your email address.</p>
      </div>
      {phase === "sent" ? (
        <div className={`${ui.panel} p-4`} role="status">
          <p className="font-medium">Check your email</p>
          <p className="mt-1 text-sm text-ink-2">
            We sent a sign-in link to {email}. It expires in 5 minutes.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label className={ui.label} htmlFor="email">
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
            aria-invalid={phase === "error" ? true : undefined}
            aria-describedby={phase === "error" ? "sign-in-error" : undefined}
            className={ui.input}
          />
          <button type="submit" disabled={phase === "sending"} className={`${ui.buttonPrimary} mt-2`}>
            {phase === "sending" ? "Sending" : "Send sign-in link"}
          </button>
          {phase === "error" ? (
            <p id="sign-in-error" className={ui.errorText}>
              {errorMessage}
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}
