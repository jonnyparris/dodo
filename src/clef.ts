/**
 * Clef: Cloudflare's decision models on Workers AI. Not LLMs. They score a
 * schema of typed questions (yes/no, choice, score) against a state of
 * text, JSON or images in ~150-350 ms, for ~$0.04 per M input tokens
 * (clef-flash). Dodo uses Clef for:
 *
 *  - image_check: cheap answers about images (uploads, screenshots,
 *    workspace files) for any model, including ones that can't see images.
 *  - routing: is an image message asking for an edit (Replicate) or for an
 *    answer (the session model)?
 *
 * https://blog.cloudflare.com/clef-faster-cheaper-multimodal/
 */
import { log } from "./logger";

export const CLEF_MODEL = "@cf/cloudflare/clef-flash";

export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number };

export interface ClefRequest {
  state: unknown;
  questions: Record<string, ClefQuestion>;
  /** Data URLs (PNG, JPEG, WebP), max 4. */
  images?: string[];
}

export interface ClefResult {
  answers: Record<string, ClefAnswer>;
  inputTokens: number;
}

export const CLEF_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const CLEF_MAX_IMAGES = 4;

export async function runClef(ai: Ai, req: ClefRequest): Promise<ClefResult> {
  const out = (await ai.run(CLEF_MODEL as never, {
    model: "clef-flash",
    state: req.state,
    questions: req.questions,
    ...(req.images?.length ? { images: req.images } : {}),
  } as never)) as { answers?: Record<string, ClefAnswer>; usage?: { input_tokens?: number } };
  if (!out?.answers) throw new Error("Clef returned no answers");
  return { answers: out.answers, inputTokens: out.usage?.input_tokens ?? 0 };
}

/** Minimum P(edit) to send an image message to Replicate instead of the model. */
export const EDIT_INTENT_THRESHOLD = 0.6;

/**
 * Does this message ask to edit / make an image (Replicate), or for an
 * answer (the session model)? Text-only check: ~190 tokens, ~150 ms.
 * `context` says which image is in play. Falls back to "ask" if Clef fails:
 * a text answer is the safer miss than an unwanted image edit.
 */
export async function classifyImageIntent(ai: Ai | undefined, message: string, context: string): Promise<{ intent: "edit" | "ask"; pEdit: number | null }> {
  if (!ai) return { intent: "ask", pEdit: null };
  try {
    const { answers } = await runClef(ai, {
      state: { user_message: message, context },
      questions: {
        intent: {
          type: "choice",
          instructions: "What does the user want done with the image?",
          criteria: {
            edit: "Change, edit, restyle, extend or make a new version of the image: the answer is an image.",
            ask: "A question about the image, a description, analysis, or anything else answered in text.",
          },
        },
      },
    });
    const a = answers.intent;
    const pEdit = a?.type === "choice" ? (a.probabilities.edit ?? 0) : 0;
    return { intent: pEdit >= EDIT_INTENT_THRESHOLD ? "edit" : "ask", pEdit };
  } catch (err) {
    log("warn", "clef intent check failed; answering in text", { error: err instanceof Error ? err.message : String(err) });
    return { intent: "ask", pEdit: null };
  }
}
