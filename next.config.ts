import type { NextConfig } from "next";
// agentRules: Next 16 writes AGENTS.md and CLAUDE.md into the repo on every
// dev/build run; disabled to keep the scaffold limited to the planned files.
const nextConfig: NextConfig = { agentRules: false };
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
