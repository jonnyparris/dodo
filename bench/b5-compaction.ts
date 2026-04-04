/**
 * B5: Multi-turn compaction benchmark.
 *
 * Measures token efficiency across a 10-turn session that triggers compaction.
 * Each turn builds on prior context. Turn 10 is a memory retention test.
 *
 * Metrics captured per turn:
 * - Cumulative input/output tokens
 * - Context usage % (should plateau, not grow linearly)
 * - Whether compaction was triggered (inferred from context % dropping)
 *
 * Run: npx tsx bench/b5-compaction.ts <DODO_BASE_URL>
 * Example: npx tsx bench/b5-compaction.ts https://dodo.jonnyparris.workers.dev
 *
 * Requires DODO_SESSION_TOKEN env var or CF Access cookie for auth.
 */

const TURNS = [
  {
    id: "T1",
    label: "workspace discovery",
    prompt:
      "List the top-level directory structure of this workspace. Just the root entries — don't recurse into subdirectories.",
  },
  {
    id: "T2",
    label: "deep read (imports)",
    prompt:
      "Read src/coding-agent.ts lines 1-50. Explain each import — what does it bring in and why does this file need it?",
  },
  {
    id: "T3",
    label: "codebase search",
    prompt:
      'Find all uses of "maybeCompactContext" across the codebase. List every file and line number where it appears.',
  },
  {
    id: "T4",
    label: "method analysis",
    prompt:
      "Read the assembleContext method in src/coding-agent.ts. Explain the token budget enforcement logic — how does the hybrid tracking work?",
  },
  {
    id: "T5",
    label: "constant extraction",
    prompt:
      "What model constants are defined in CONTEXT_WINDOW_TOKENS? List every entry with its token count.",
  },
  {
    id: "T6",
    label: "broad search (test files)",
    prompt:
      "Find all test files (*.test.ts) and give a one-line summary of what each test file covers.",
  },
  {
    id: "T7",
    label: "cross-reference (retention)",
    prompt:
      "What is COMPACTION_TRIGGER_PERCENT set to, and trace how it flows from the constant declaration through maybeCompactContext to the actual compaction decision. Don't re-read files you already read — use what you know.",
  },
  {
    id: "T8",
    label: "deep read (overflow)",
    prompt:
      "Read the overflow recovery logic in the onChatMessage agentic loop. How does it detect overflow errors, and what does it do when one is caught?",
  },
  {
    id: "T9",
    label: "synthesis",
    prompt:
      "Based on everything you've learned about this codebase across our conversation, what are the 3 biggest token efficiency risks? Be specific — reference file paths and line numbers.",
  },
  {
    id: "T10",
    label: "memory retention test",
    prompt:
      "What was the very first file you read in this session (turn 2), and what were its imports? Answer from memory — do NOT re-read the file.",
  },
];

interface TurnResult {
  turnId: string;
  label: string;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  contextUsagePercent: number;
  contextBudget: number;
  durationMs: number;
  status: "completed" | "failed" | "timeout";
  error?: string;
}

interface SessionState {
  status: string;
  totalTokenInput: number;
  totalTokenOutput: number;
  contextUsagePercent: number;
  contextBudget: number;
  contextWindow: number;
  messageCount: number;
  activePromptId?: string | null;
}

async function fetchApi(baseUrl: string, path: string, options?: RequestInit): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  // Auth: use CF Access headers if available
  const token = process.env.CF_ACCESS_TOKEN;
  if (token) {
    headers["cf-access-token"] = token;
  }

  return fetch(url, { ...options, headers });
}

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetchApi(baseUrl, "/session", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function cloneRepo(baseUrl: string, sessionId: string): Promise<void> {
  const res = await fetchApi(baseUrl, `/session/${sessionId}/git/clone`, {
    method: "POST",
    body: JSON.stringify({ url: "https://github.com/jonnyparris/dodo", depth: 1 }),
  });
  if (!res.ok) throw new Error(`Failed to clone repo: ${res.status}`);
}

async function sendPrompt(baseUrl: string, sessionId: string, content: string): Promise<string> {
  const res = await fetchApi(baseUrl, `/session/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to send prompt: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { promptId: string };
  return body.promptId;
}

async function getSession(baseUrl: string, sessionId: string): Promise<SessionState> {
  const res = await fetchApi(baseUrl, `/session/${sessionId}`);
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
  return (await res.json()) as SessionState;
}

async function waitForCompletion(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number = 180_000,
): Promise<SessionState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getSession(baseUrl, sessionId);
    if (state.status === "idle" && !state.activePromptId) {
      return state;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Timeout waiting for prompt completion after ${timeoutMs}ms`);
}

async function runBenchmark(baseUrl: string): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  B5: Multi-turn compaction benchmark");
  console.log(`  Target: ${baseUrl}`);
  console.log(`  Turns: ${TURNS.length}`);
  console.log("═══════════════════════════════════════════════════\n");

  // Setup
  console.log("Setting up session...");
  const sessionId = await createSession(baseUrl);
  console.log(`  Session: ${sessionId}`);

  console.log("  Cloning repo (shallow)...");
  await cloneRepo(baseUrl, sessionId);
  console.log("  Clone complete.\n");

  const results: TurnResult[] = [];
  let prevInputTokens = 0;
  let prevOutputTokens = 0;

  // Run turns sequentially
  for (const turn of TURNS) {
    const turnStart = Date.now();
    console.log(`── ${turn.id}: ${turn.label} ──`);
    console.log(`   Prompt: ${turn.prompt.slice(0, 80)}...`);

    let status: "completed" | "failed" | "timeout" = "completed";
    let error: string | undefined;
    let state: SessionState;

    try {
      await sendPrompt(baseUrl, sessionId, turn.prompt);
      state = await waitForCompletion(baseUrl, sessionId);
    } catch (err) {
      status = err instanceof Error && err.message.includes("Timeout") ? "timeout" : "failed";
      error = err instanceof Error ? err.message : String(err);
      // Get current state even on failure
      try {
        state = await getSession(baseUrl, sessionId);
      } catch {
        console.log(`   ✗ ${status}: ${error}\n`);
        results.push({
          turnId: turn.id,
          label: turn.label,
          cumulativeInputTokens: prevInputTokens,
          cumulativeOutputTokens: prevOutputTokens,
          turnInputTokens: 0,
          turnOutputTokens: 0,
          contextUsagePercent: 0,
          contextBudget: 0,
          durationMs: Date.now() - turnStart,
          status,
          error,
        });
        continue;
      }
    }

    const turnInputTokens = state!.totalTokenInput - prevInputTokens;
    const turnOutputTokens = state!.totalTokenOutput - prevOutputTokens;
    const durationMs = Date.now() - turnStart;

    const result: TurnResult = {
      turnId: turn.id,
      label: turn.label,
      cumulativeInputTokens: state!.totalTokenInput,
      cumulativeOutputTokens: state!.totalTokenOutput,
      turnInputTokens,
      turnOutputTokens,
      contextUsagePercent: state!.contextUsagePercent,
      contextBudget: state!.contextBudget,
      durationMs,
      status,
      error,
    };
    results.push(result);

    prevInputTokens = state!.totalTokenInput;
    prevOutputTokens = state!.totalTokenOutput;

    // Detect compaction: if context usage % drops between turns, compaction happened
    const prevResult = results.length >= 2 ? results[results.length - 2] : null;
    const compactionDetected =
      prevResult && result.contextUsagePercent < prevResult.contextUsagePercent - 10;

    console.log(
      `   ${status === "completed" ? "✓" : "✗"} ${(turnInputTokens / 1000).toFixed(0)}k in / ${turnOutputTokens} out | cumulative: ${(state!.totalTokenInput / 1000).toFixed(0)}k | context: ${state!.contextUsagePercent}% | ${(durationMs / 1000).toFixed(1)}s${compactionDetected ? " ⚡ COMPACTION DETECTED" : ""}`,
    );
    if (error) console.log(`   Error: ${error}`);
    console.log();
  }

  // Summary table
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Results Summary");
  console.log("═══════════════════════════════════════════════════\n");

  console.log(
    "| Turn | Label | Turn Input | Cumulative | Context % | Duration | Status |",
  );
  console.log(
    "|------|-------|-----------|------------|-----------|----------|--------|",
  );

  for (const r of results) {
    console.log(
      `| ${r.turnId} | ${r.label.padEnd(25)} | ${(r.turnInputTokens / 1000).toFixed(0).padStart(6)}k | ${(r.cumulativeInputTokens / 1000).toFixed(0).padStart(8)}k | ${String(r.contextUsagePercent).padStart(7)}% | ${(r.durationMs / 1000).toFixed(1).padStart(6)}s | ${r.status} |`,
    );
  }

  // Analysis
  console.log("\n── Analysis ──\n");

  const completedResults = results.filter((r) => r.status === "completed");
  if (completedResults.length < 2) {
    console.log("Not enough completed turns for analysis.");
    return;
  }

  // Check if token usage grows linearly or plateaus
  const inputPerTurn = completedResults.map((r) => r.turnInputTokens);
  const avgFirstHalf =
    inputPerTurn.slice(0, Math.floor(inputPerTurn.length / 2)).reduce((a, b) => a + b, 0) /
    Math.floor(inputPerTurn.length / 2);
  const avgSecondHalf =
    inputPerTurn.slice(Math.floor(inputPerTurn.length / 2)).reduce((a, b) => a + b, 0) /
    (inputPerTurn.length - Math.floor(inputPerTurn.length / 2));

  const growthRatio = avgSecondHalf / avgFirstHalf;
  console.log(`  Avg input tokens (first half):  ${(avgFirstHalf / 1000).toFixed(0)}k`);
  console.log(`  Avg input tokens (second half): ${(avgSecondHalf / 1000).toFixed(0)}k`);
  console.log(`  Growth ratio: ${growthRatio.toFixed(2)}x`);

  if (growthRatio < 1.2) {
    console.log("  ✓ Token usage PLATEAUS — compaction is working");
  } else if (growthRatio < 1.5) {
    console.log("  ~ Token usage grows SLOWLY — compaction helps but doesn't fully flatten");
  } else {
    console.log("  ✗ Token usage grows LINEARLY — compaction is not effective");
  }

  // Check context usage %
  const maxContextPercent = Math.max(...completedResults.map((r) => r.contextUsagePercent));
  const finalContextPercent = completedResults[completedResults.length - 1].contextUsagePercent;
  console.log(`\n  Peak context usage: ${maxContextPercent}%`);
  console.log(`  Final context usage: ${finalContextPercent}%`);

  if (finalContextPercent < maxContextPercent - 10) {
    console.log("  ✓ Context usage dropped — compaction reclaimed space");
  } else {
    console.log("  ~ Context usage didn't drop significantly after compaction");
  }

  // Total cost
  const totalInput = completedResults[completedResults.length - 1].cumulativeInputTokens;
  const totalOutput = completedResults[completedResults.length - 1].cumulativeOutputTokens;
  const linearEstimate = completedResults[0].turnInputTokens * completedResults.length;
  const savings = linearEstimate > 0 ? ((1 - totalInput / linearEstimate) * 100).toFixed(0) : "N/A";

  console.log(`\n  Total input tokens: ${(totalInput / 1000).toFixed(0)}k`);
  console.log(`  Total output tokens: ${totalOutput}`);
  console.log(`  Linear estimate (no compaction): ${(linearEstimate / 1000).toFixed(0)}k`);
  console.log(`  Savings vs linear: ${savings}%`);

  // T10 retention test
  const t10 = results.find((r) => r.turnId === "T10");
  if (t10 && t10.status === "completed") {
    console.log(`\n  T10 (memory retention): completed in ${(t10.durationMs / 1000).toFixed(1)}s`);
    console.log("  → Check assistant response manually to verify it remembers T2 imports");
  }

  console.log(`\n  Session ID: ${sessionId}`);
  console.log("  (inspect messages via dodo_get_messages for qualitative analysis)\n");
}

// Entry point
const baseUrl = process.argv[2] || "https://dodo.jonnyparris.workers.dev";
runBenchmark(baseUrl).catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
