import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { adaptTool } from "../src/pi/tools";

describe("adaptTool execute options", () => {
  it("passes the call id, abort signal and an empty AI SDK 7 tool context", async () => {
    const execute = vi.fn(async () => "ok");
    const reg = await adaptTool("x", tool({ description: "x", inputSchema: jsonSchema({ type: "object", properties: {} }), execute }) as never);
    const signal = new AbortController().signal;
    const out = await reg.execute({ a: 1 } as never, { callId: "call_1" } as never, { abortSignal: signal } as never);
    expect(execute).toHaveBeenCalledWith({ a: 1 }, { toolCallId: "call_1", messages: [], abortSignal: signal, context: {} });
    expect(out).toEqual({ output: [{ type: "text", text: "ok" }] });
  });
});
