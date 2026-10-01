import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

// getAuth() per request: the Cloudflare context (D1, secrets) is request-scoped.
export const { GET, POST } = toNextJsHandler((request: Request) =>
  getAuth().handler(request),
);
