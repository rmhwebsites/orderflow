"use client";

import { useEffect, useState } from "react";

// The current time, re-read every intervalMs, for relative times and
// countdowns. Starts at 0 until mounted so server and client renders agree.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
