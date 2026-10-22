// A fake Workers `AI` binding for createAI tests: records every
// `env.AI.gateway(id).run(...)` universal call and answers with `respond`.

/** A fake `AI` binding that records universal gateway calls. */
export function fakeAIBinding(respond: (query: Record<string, unknown>) => Response) {
  const calls: Array<{ gatewayId: string; request: { provider: string; endpoint: string; headers: Record<string, string>; query: Record<string, unknown> }; options: Record<string, unknown> }> = [];
  const binding = {
    gateway: (gatewayId: string) => ({
      run: async (request: (typeof calls)[number]["request"], options: Record<string, unknown>) => {
        calls.push({ gatewayId, request, options });
        return respond(request.query);
      },
    }),
    run: async () => {
      throw new Error("Workers AI run path not expected");
    },
  };
  return { binding: binding as unknown as Ai, calls };
}
