/**
 * image_check: ask Clef typed questions about images. Works for models that
 * can't see images, and saves context for those that can (a screenshot
 * check costs a few hundred Clef tokens instead of an image in the prompt).
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { CLEF_IMAGE_TYPES, CLEF_MAX_IMAGES, type ClefAnswer, type ClefQuestion, runClef } from "../clef";

export type ResolveImage = (ref: string) => Promise<{ mediaType: string; dataUrl: string } | { error: string }>;

const questionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).describe("Short id for the answer, e.g. 'colour'"),
  kind: z.enum(["yes_no", "choice", "score"]),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(50).optional().describe("choice: the possible answers"),
  levels: z.array(z.string().min(1)).min(2).max(10).optional().describe("score: rubric levels, lowest first"),
});

export function createImageCheckTool(opts: { ai: Ai; resolveImage: ResolveImage }) {
  return tool({
    description:
      "Answer questions about images with Clef, a fast decision model (~0.3 s, near-free). " +
      "Use it to check images you can't see (uploads on a text-only model) or to check screenshots without loading them into context. " +
      "Clef does not write descriptions: ask yes/no, choice (pick one of your options) or score (rate on your levels) questions. " +
      "For open questions, offer broad options (e.g. colours, object types) and narrow down with a follow-up. " +
      "`images`: dodo-attachment:// URLs from this session (uploads, screenshots) or workspace paths (png/jpeg/webp).",
    inputSchema: zodSchema(
      z.object({
        images: z.array(z.string().min(1)).min(1).max(CLEF_MAX_IMAGES),
        context: z.string().optional().describe("Optional text to judge alongside the images"),
        questions: z.array(questionSchema).min(1).max(16),
      }),
    ),
    execute: async ({ images, context, questions }) => {
      const urls: string[] = [];
      for (const ref of images) {
        const r = await opts.resolveImage(ref);
        if ("error" in r) return { error: `${ref}: ${r.error}` };
        if (!CLEF_IMAGE_TYPES.has(r.mediaType)) return { error: `${ref}: ${r.mediaType} not supported (png, jpeg, webp)` };
        urls.push(r.dataUrl);
      }
      const mapped: Record<string, ClefQuestion> = {};
      for (const q of questions) {
        if (q.kind === "yes_no") mapped[q.id] = { type: "noul", instructions: q.question };
        else if (q.kind === "choice") {
          if (!q.options) return { error: `question '${q.id}': choice needs options` };
          mapped[q.id] = { type: "choice", instructions: q.question, criteria: Object.fromEntries(q.options.map((o) => [o, o])) };
        } else {
          if (!q.levels) return { error: `question '${q.id}': score needs levels` };
          mapped[q.id] = { type: "score", instructions: q.question, criteria: q.levels };
        }
      }
      try {
        const { answers } = await runClef(opts.ai, { state: context?.trim() || "The attached image(s).", questions: mapped, images: urls });
        return { answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, summarize(a)])) };
      } catch (err) {
        return { error: `Clef failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function summarize(a: ClefAnswer) {
  if (a.type === "noul") return { yes: round(a.noul) };
  const top = Object.entries(a.probabilities)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([k, p]) => [k, round(p)]);
  if (a.type === "choice") return { answer: a.choice, confidence: round(a.confidence), top: Object.fromEntries(top) };
  return { score: round(a.score), confidence: round(a.confidence), legend: a.legend };
}
