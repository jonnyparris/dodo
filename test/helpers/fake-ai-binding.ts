// A fake Workers `AI` binding for createAI tests: records every
// `env.AI.gateway(id).run(...)` universal call and answers with `respond`,
// and (when `runRespond` is given) every Workers AI `env.AI.run(...)` call.

/** One Workers AI run-path call: `env.AI.run(model, inputs, options)`. */
export interface FakeRunCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown>;
}

/** A fake `AI` binding that records universal gateway calls and, optionally, run-path calls. */
export function fakeAIBinding(respond: (query: Record<string, unknown>) => Response, runRespond?: (call: FakeRunCall) => Response) {
  const runCalls: FakeRunCall[] = [];
  const calls: Array<{ gatewayId: string; request: { provider: string; endpoint: string; headers: Record<string, string>; query: Record<string, unknown> }; options: Record<string, unknown> }> = [];
  const binding = {
    gateway: (gatewayId: string) => ({
      run: async (request: (typeof calls)[number]["request"], options: Record<string, unknown>) => {
        // Like workerd without enable_abortsignal_rpc: an AbortSignal can't cross the binding.
        if (options && Object.values(options).some((v) => v instanceof AbortSignal)) {
          throw new Error("AbortSignal serialization is not enabled.");
        }
        calls.push({ gatewayId, request, options });
        return respond(request.query);
      },
    }),
    run: async (model: string, inputs: Record<string, unknown>, options: Record<string, unknown>) => {
      if (!runRespond) throw new Error("Workers AI run path not expected");
      if (options && Object.values(options).some((v) => v instanceof AbortSignal)) {
        throw new Error("AbortSignal serialization is not enabled.");
      }
      const call = { model, inputs, options };
      runCalls.push(call);
      return runRespond(call);
    },
  };
  // Like an RPC stub: `.bind` / `.call` / `.apply` / `then` on a method or
  // on gateway(id) would be remote calls in workerd. Fail loudly instead.
  const rpcLike = <T extends object>(obj: T): T =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        if (prop === "then") throw new Error("RPC stub awaited");
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return new Proxy(value, {
          get(fn, p) {
            if (p === "bind" || p === "call" || p === "apply") throw new Error(`RPC stub method .${String(p)}() would be a remote call`);
            return Reflect.get(fn, p);
          },
          apply(fn, _this, args) {
            const out = Reflect.apply(fn, target, args);
            return out && typeof out === "object" && !(out instanceof Promise) ? rpcLike(out as object) : out;
          },
        });
      },
    });
  return { binding: rpcLike(binding) as unknown as Ai, calls, runCalls };
}
