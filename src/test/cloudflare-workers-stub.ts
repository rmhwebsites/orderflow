// Test-only stand-in for the "cloudflare:workers" module, which exists only
// inside workerd. vitest.config.ts aliases the module here so Durable Object
// classes can be constructed with a fake ctx in Node tests.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
