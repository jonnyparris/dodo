declare module "cloudflare:test" {
  import type * as Rpc from "cloudflare:workers";
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function runInDurableObject<
    O extends DurableObject | Rpc.DurableObject,
    R,
  >(
    stub: DurableObjectStub<O>,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
  /** Evict a running Durable Object (vitest-pool-workers >= 0.2x). */
  export function evictDurableObject(stub: DurableObjectStub, options?: { webSockets?: "close" | "keep" }): Promise<void>;
}
