import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerVerifyWorkflow, pollVerifyWorkflow } from "../src/github-actions";
import type { Env, WorkerRunRecord } from "../src/types";

const baseRun: WorkerRunRecord = {
  baseBranch: "main",
  branch: "feat/x",
  commitMessage: "test",
  createdAt: new Date().toISOString(),
  expectedFiles: [],
  failureSnapshotId: null,
  id: "run-1",
  lastError: null,
  parentSessionId: null,
  prUrl: null,
  repoDir: "/dodo",
  repoId: "dodo",
  repoUrl: "https://github.com/jonnyparris/dodo",
  sessionId: "sess-1",
  status: "prompt_running",
  strategy: "agent",
  title: "Test run",
  updatedAt: new Date().toISOString(),
  verification: null,
  verifyWorkflow: "dodo-verify.yml",
  verifyWorkflowRunId: null,
  verifyWorkflowHtmlUrl: null,
};

function makeEnv(token = "test-token"): Env {
  return { GITHUB_TOKEN: token } as unknown as Env;
}

describe("triggerVerifyWorkflow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("returns null when verifyWorkflow is not set", async () => {
    const run = { ...baseRun, verifyWorkflow: null };
    const result = await triggerVerifyWorkflow({ env: makeEnv(), run });
    expect(result).toBeNull();
  });

  it("returns null when repoUrl is not a github.com URL", async () => {
    const run = { ...baseRun, repoUrl: "https://gitlab.com/foo/bar" };
    const result = await triggerVerifyWorkflow({ env: makeEnv(), run });
    expect(result).toBeNull();
  });

  it("returns null when no token is available", async () => {
    const env = { GITHUB_TOKEN: undefined } as unknown as Env;
    const result = await triggerVerifyWorkflow({ env, run: baseRun });
    expect(result).toBeNull();
  });

  it("dispatches the workflow and returns the newly-created run id", async () => {
    const now = Date.now();
    const fetchMock = vi
      .fn()
      // 1st call: workflow_dispatch — 204 No Content
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // 2nd call: list runs — one run created after our trigger
      .mockResolvedValueOnce(new Response(JSON.stringify({
        workflow_runs: [
          { id: 999, html_url: "https://github.com/jonnyparris/dodo/actions/runs/999", created_at: new Date(now).toISOString() },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = triggerVerifyWorkflow({ env: makeEnv(), run: baseRun });
    // Drain the internal sleep between trigger and list.
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result).toEqual({ runId: "999", htmlUrl: "https://github.com/jonnyparris/dodo/actions/runs/999" });

    // Verify the dispatch call targeted the right endpoint.
    const [triggerUrl, triggerInit] = fetchMock.mock.calls[0];
    expect(String(triggerUrl)).toContain("/actions/workflows/dodo-verify.yml/dispatches");
    expect(triggerInit.method).toBe("POST");
    expect(JSON.parse(triggerInit.body)).toEqual({ ref: "feat/x" });
  });

  it("ignores stale workflow runs created before the trigger", async () => {
    const now = Date.now();
    // Run created 5 minutes ago — clearly unrelated.
    const staleTs = new Date(now - 5 * 60_000).toISOString();
    const makeStaleResponse = () => new Response(JSON.stringify({
      workflow_runs: [{ id: 1, html_url: "x", created_at: staleTs }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementation(async () => makeStaleResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = triggerVerifyWorkflow({ env: makeEnv(), run: baseRun });
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise;
    expect(result).toBeNull();
  });
});

describe("pollVerifyWorkflow", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when runId is missing", async () => {
    const result = await pollVerifyWorkflow({ env: makeEnv(), run: baseRun });
    expect(result).toBeNull();
  });

  it("returns null while the workflow is still running", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/x/y/actions/runs/1",
      updated_at: new Date().toISOString(),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await pollVerifyWorkflow({
      env: makeEnv(),
      run: { ...baseRun, verifyWorkflowRunId: "42" },
    });
    expect(result).toBeNull();
  });

  it("returns the conclusion when the workflow completes successfully", async () => {
    const ts = new Date().toISOString();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/x/y/actions/runs/42",
      updated_at: ts,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await pollVerifyWorkflow({
      env: makeEnv(),
      run: { ...baseRun, verifyWorkflowRunId: "42" },
    });
    expect(result).toEqual({
      conclusion: "success",
      htmlUrl: "https://github.com/x/y/actions/runs/42",
      completedAt: ts,
    });
  });

  it("surfaces failure conclusions", async () => {
    const ts = new Date().toISOString();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/x/y/actions/runs/99",
      updated_at: ts,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await pollVerifyWorkflow({
      env: makeEnv(),
      run: { ...baseRun, verifyWorkflowRunId: "99" },
    });
    expect(result?.conclusion).toBe("failure");
  });
});
