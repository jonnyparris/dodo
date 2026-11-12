// A fake Workers `AI` binding for createAI tests: records every
// `env.AI.gateway(id).run(...)` universal call and every AI Gateway catalog
// `env.AI.run("anthropic/…", body, { gateway })` call (createAI's Anthropic
// leg since agents 0.29) and answers both with `respond`, and (when
// `runRespond` is given) every Workers AI `env.AI.run("@cf/…")` call.

/** One Workers AI run-path call: `env.AI.run(model, inputs, options)`. */
export interface FakeRunCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown>;
}

/** A fake `AI` binding that records universal gateway calls, catalog run calls and, optionally, Workers AI run-path calls. */
export function fakeAIBinding(respond: (query: Record<string, unknown>) => Response, runRespond?: (call: FakeRunCall) => Response) {
  const runCalls: FakeRunCall[] = [];
  const catalogCalls: FakeRunCall[] = [];
  const calls: Array<{ gatewayId: string; via?: "fetch"; request: { provider: string; endpoint: string; headers: Record<string, string>; query: Record<string, unknown> }; options: Record<string, unknown> }> = [];
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
    // createAI's provider-native path (agents 0.29+, model objects such as
    // `ai.routed(anthropic(...))`): `env.AI.fetch` to
    // `https://workers-binding.ai/ai-gateway/gateways/{id}/{provider}/{endpoint}`.
    // Recorded in `calls` like a universal call; the gateway options arrive
    // as `cf-aig-*` headers, so `options.gateway.metadata` is read back from
    // `cf-aig-metadata`.
    fetch: async (input: string, init?: RequestInit) => {
      if (init?.signal) throw new Error("AbortSignal serialization is not enabled.");
      const match = /\/ai-gateway\/gateways\/([^/]+)\/([^/]+)\/(.+)$/.exec(new URL(input).pathname);
      if (!match) throw new Error(`unexpected AI binding fetch: ${input}`);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
      const query = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const metadata = headers["cf-aig-metadata"] ? JSON.parse(headers["cf-aig-metadata"]) : undefined;
      calls.push({ gatewayId: decodeURIComponent(match[1]!), via: "fetch", request: { provider: match[2]!, endpoint: match[3]!, headers, query }, options: { gateway: { metadata } } });
      return respond(query);
    },
    run: async (model: string, inputs: Record<string, unknown>, options: Record<string, unknown>) => {
      if (options && Object.values(options).some((v) => v instanceof AbortSignal)) {
        throw new Error("AbortSignal serialization is not enabled.");
      }
      if (!model.startsWith("@cf/")) {
        catalogCalls.push({ model, inputs, options });
        return respond(inputs);
      }
      if (!runRespond) throw new Error("Workers AI run path not expected");
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
  return { binding: rpcLike(binding) as unknown as Ai, calls, runCalls, catalogCalls };
}
