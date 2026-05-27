/**
 * Unit tests for the Workflow contract.
 *
 * The runner is the boundary: it validates payload, calls the body,
 * validates the result, and emits the lifecycle events. These tests
 * pin those invariants directly so a refactor that drops any of them
 * fails the build.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  runWorkflow,
  type Workflow,
  type WorkflowContext,
  type WorkflowEvent,
} from "../src/workflow";

function makeWorkflow(): Workflow<{ message: string }, { echoed: string }> {
  return {
    name: "test-echo",
    description: "Echoes the message back, used in the workflow unit test suite.",
    payloadSchema: z.object({ message: z.string().min(1) }),
    resultSchema: z.object({ echoed: z.string() }),
    async run(ctx: WorkflowContext<{ message: string }>) {
      return { echoed: ctx.payload.message };
    },
  };
}

describe("runWorkflow", () => {
  it("validates the payload before calling the body", async () => {
    const workflow = makeWorkflow();
    const emit = vi.fn<(event: WorkflowEvent) => void>();
    await expect(
      runWorkflow(workflow, { message: "" }, {
        runId: "r1",
        sessionId: "s1",
        emit,
      }),
    ).rejects.toThrow();
    // Failed payload validation aborts before any lifecycle event.
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits run_start before the body runs", async () => {
    const workflow: Workflow<{ message: string }, { echoed: string }> = {
      ...makeWorkflow(),
      async run(ctx: WorkflowContext<{ message: string }>) {
        // Capture the events that have been emitted by the time the
        // body starts. Exactly one — `run_start`.
        ctx.emit({
          kind: "step",
          runId: ctx.runId,
          workflow: "test-echo",
          at: new Date().toISOString(),
          name: "body-entry",
        });
        return { echoed: ctx.payload.message };
      },
    };
    const events: WorkflowEvent[] = [];
    await runWorkflow(workflow, { message: "hi" }, {
      runId: "r1",
      sessionId: "s1",
      emit: (e) => events.push(e),
    });
    expect(events[0].kind).toBe("run_start");
    expect(events.find((e) => e.kind === "step" && e.name === "body-entry")).toBeDefined();
    expect(events[events.length - 1].kind).toBe("run_end");
  });

  it("emits run_end ok=true and returns the validated result on success", async () => {
    const workflow = makeWorkflow();
    const events: WorkflowEvent[] = [];
    const out = await runWorkflow(workflow, { message: "hi" }, {
      runId: "r1",
      sessionId: "s1",
      emit: (e) => events.push(e),
    });
    expect(out.result.echoed).toBe("hi");
    expect(out.runId).toBe("r1");
    const end = events[events.length - 1];
    expect(end.kind).toBe("run_end");
    if (end.kind === "run_end") {
      expect(end.ok).toBe(true);
      expect(end.error).toBeUndefined();
    }
  });

  it("emits run_end ok=false with the error message when the body throws", async () => {
    const workflow: Workflow<{ message: string }, { echoed: string }> = {
      ...makeWorkflow(),
      async run() {
        throw new Error("kaboom");
      },
    };
    const events: WorkflowEvent[] = [];
    await expect(
      runWorkflow(workflow, { message: "hi" }, {
        runId: "r1",
        sessionId: "s1",
        emit: (e) => events.push(e),
      }),
    ).rejects.toThrow("kaboom");
    const end = events[events.length - 1];
    expect(end.kind).toBe("run_end");
    if (end.kind === "run_end") {
      expect(end.ok).toBe(false);
      expect(end.error).toContain("kaboom");
    }
  });

  it("validates the body's result against the result schema", async () => {
    // Body returns a value that doesn't match the declared resultSchema.
    // The runner should reject — drift between body and schema is a
    // workflow bug, not a caller bug.
    const broken: Workflow<{ message: string }, { echoed: string }> = {
      ...makeWorkflow(),
      async run() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { wrongField: "oops" } as any;
      },
    };
    const events: WorkflowEvent[] = [];
    await expect(
      runWorkflow(broken, { message: "hi" }, {
        runId: "r1",
        sessionId: "s1",
        emit: (e) => events.push(e),
      }),
    ).rejects.toThrow();
    // The failure path still emits run_end with ok=false — observability
    // matters more than the type contract here.
    const end = events[events.length - 1];
    expect(end.kind).toBe("run_end");
    if (end.kind === "run_end") {
      expect(end.ok).toBe(false);
    }
  });

  it("records a non-negative durationMs", async () => {
    const workflow = makeWorkflow();
    const out = await runWorkflow(workflow, { message: "hi" }, {
      runId: "r1",
      sessionId: "s1",
      emit: () => undefined,
    });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});
