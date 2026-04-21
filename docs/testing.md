# Testing Dodo

Notes and helpers for writing tests that hold up under `@cloudflare/vitest-pool-workers`.
Read this before you spend an afternoon debugging why a DO cache "forgot" something or
why `JSON.parse` rejects an MCP response.

## 1. Durable Object state doesn't persist across MCP test requests

A DO instance may be re-instantiated between test requests under the vitest pool.
In-memory caches (plain class fields) you set in one MCP call are **not guaranteed**
to be present when the next MCP call looks up the same DO by name.

**Symptom.** A test primes DO state, then calls a second endpoint that round-trips
through MCP (`getAgentByName` → `.fetch(...)`), and the cached field is `undefined`.

```ts
// ❌ Flaky — the cache may be gone by the time /mcp reads it
const ctx = await agent.getOrCreateArtifactsContext(); // sets _artifactsRepo on DO
// ...
const forked = await fetchJson("/mcp", {
  body: JSON.stringify({ /* fork_session call */ }),
});
expect(forked._artifactsRepo).toBeDefined(); // may fail
```

**Fix.** For tests that assert on DO state, talk to the DO directly with
`ns.get(ns.idFromName(id))` instead of round-tripping through MCP. Reserve MCP tests
for end-to-end behaviour you don't mind re-priming.

```ts
// ✅ Reliable — single DO instance
const stub = env.CODING_AGENT.get(env.CODING_AGENT.idFromName(sessionId));
const res = await stub.fetch(new Request("https://agent/artifacts-context"));
```

If you do need to exercise MCP end-to-end, assert on observable side effects
(outgoing HTTP calls, push notifications, committed state in storage) rather than
in-memory caches.

## 2. MCP responses are SSE, not JSON

The MCP endpoint returns `text/event-stream`. `JSON.parse(await res.text())` fails
with `Unexpected token 'e', "event: mes"...`.

**Parse the SSE frame explicitly:**

```ts
export async function parseMcpResponse<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`No data frame in MCP response: ${text}`);
  return JSON.parse(dataLine.replace(/^data:\s*/, "")) as T;
}
```

Use it in every MCP test:

```ts
const res = await fetchMcp("tools/call", { name: "fork_session", arguments: { ... } });
const body = await parseMcpResponse<{ sessionId: string }>(res);
```

## 3. Vitest `vi.mock` doesn't rewrite same-module references

`vi.mock("../src/notify", ...)` replaces the module's *external* export but **not**
references used internally within the same module. If `sendRunNotification` calls
`sendNotification` in the same file, the internal call site bypasses the mock.

**Symptom.** Your mock spy records zero calls even though the code clearly invoked
the function.

**Fix.** Don't assert on the mock. Assert on the side effect instead.

```ts
// ❌ Doesn't fire when sendRunNotification calls sendNotification internally
const spy = vi.spyOn(notify, "sendNotification");
await sendRunNotification(run);
expect(spy).toHaveBeenCalled();

// ✅ Observe the real effect (waitUntil, fetch call, storage write)
const waitUntilCalls: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waitUntilCalls.push(p) };
await sendRunNotification(run, ctx);
expect(waitUntilCalls).toHaveLength(1);
```

Alternative: split the module so the caller and callee live in different files. Then
`vi.mock` works normally because the internal reference is now cross-module.

## Quick checklist before committing a test

- [ ] Does the test rely on DO in-memory state surviving across fetch calls? Use
      `idFromName` + direct `.fetch`, not MCP round-trips.
- [ ] Does the test parse an MCP response? Use `parseMcpResponse`, not `JSON.parse`.
- [ ] Does the test mock a function that's called from within its own module?
      Assert on side effects, not the mock.

Closes #26.
