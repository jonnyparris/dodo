// pi-engine twin of agentic-mock: the same deterministic model behaviour
// ("<gateway>:<prompt>" echo, "This should fail" → gateway error, "slow async
// prompt" → wait for release/abort, "stuck model prompt" → ignore the abort
// and wait for releaseMockStuckPrompt()), served through pi-ai so sessions on the
// pi engine run end to end without network.
//
// Used as: vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { vi } from "vitest";
import type * as RealModels from "../../src/pi/models";
import { resolveWireModelId } from "../../src/subagent-runner";
import { mockSlowPromptWait } from "./agentic-mock";

// importActual: a plain import would resolve to this mock and deadlock.
const real = await vi.importActual<typeof RealModels>("../../src/pi/models");
export const { DODO_PROVIDER_ID, dodoModel, gatewayHeaders, agentModelRef } = real;
export type GatewayConfig = RealModels.GatewayConfig;

/** Every model context the mock saw, newest last (for assertions). */
export const seenContexts: TranscriptContext[] = [];

function lastUserText(context: TranscriptContext): string {
  const messages = context.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join(" ")
        .trim();
    }
  }
  return "";
}

// Flag-and-yield, not a stored resolver: see the note in agentic-mock.ts on
// the DO input gate.
let stuckReleased = false;
let stuckEntered = false;
/** A "stuck model prompt" request is in flight. */
export const mockStuckPromptEntered = () => stuckEntered;
/** Let a "stuck model prompt" request finish (it ignores aborts). */
export function releaseMockStuckPrompt(): void {
  stuckReleased = true;
}
async function waitForStuckRelease(): Promise<void> {
  stuckReleased = false;
  stuckEntered = true;
  for (let i = 0; i < 30_000 && !stuckReleased; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  stuckEntered = false;
}

export function setDodoProvider(models: MutableModels, modelIds: readonly string[], config: RealModels.GatewayConfig, _env: unknown): MutableModels {
  const gateway = config.activeGateway ?? "opencode";
  const ids = [...new Set(modelIds.filter(Boolean).map((id) => resolveWireModelId(id, config.activeGateway)))];
  const faux = fauxProvider({ provider: DODO_PROVIDER_ID, models: ids.map((id) => ({ id, input: ["text", "image"] as ("text" | "image")[] })) });
  const respond: FauxResponseFactory = async (context, options) => {
    faux.appendResponses([respond]); // never run dry
    seenContexts.push(context);
    const prompt = lastUserText(context);
    if (prompt.includes("This should fail") || prompt.includes("This will fail")) {
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Gateway timeout" });
    }
    if (prompt.includes("stuck model prompt")) {
      await waitForStuckRelease();
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    if (prompt.includes("slow async prompt")) {
      try {
        await mockSlowPromptWait((options as { signal?: AbortSignal } | undefined)?.signal);
      } catch {
        return fauxAssistantMessage("", { stopReason: "aborted" });
      }
    }
    return fauxAssistantMessage(`${gateway}:${prompt}`);
  };
  faux.setResponses([respond]);
  models.setProvider(faux.provider);
  return models;
}

export type { Model };
