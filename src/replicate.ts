/**
 * Replicate image client — generation + editing.
 *
 * Dodo's image path runs through Replicate (default model `google/nano-banana-2`,
 * configurable per-user via `replicateImageModel`). The model does both:
 *   - text-to-image: just a `prompt`
 *   - editing / multi-image fusion: `prompt` + one or more input images
 *
 * We call the official-model prediction endpoint with `Prefer: wait` so the
 * request blocks until the prediction is terminal (no client-side polling for
 * the common fast case), then fall back to polling the prediction's `get` URL
 * if the model is still running when the wait window elapses.
 *
 * Input images are passed as base64 `data:` URIs in `image_input`, so we never
 * need to host the user's upload anywhere — Replicate accepts data URIs.
 *
 * The function returns raw image bytes as base64 + media type so the caller can
 * persist them exactly like the old Workers AI FLUX path (R2 upload + message).
 */

import type { Env } from "./types";

/** The `input` field name nano-banana / nano-banana-2 use for edit images.
 *  Kept as a constant so a schema change is a one-line edit. Verified against
 *  the model's OpenAPI schema. */
const IMAGE_INPUT_FIELD = "image_input";

/** Hard ceiling on how long we'll wait for a prediction before giving up. */
const MAX_WAIT_MS = 120_000;
/** Delay between polls once we fall back from `Prefer: wait` to polling. */
const POLL_INTERVAL_MS = 2_000;

export interface ReplicateImageInput {
  /** base64 image data (no `data:` prefix). */
  data: string;
  /** e.g. `image/png`, `image/jpeg`. */
  mediaType: string;
}

export interface ReplicateImageResult {
  /** base64-encoded output image bytes (no `data:` prefix). */
  imageBase64: string;
  /** Media type of the output image. */
  mediaType: string;
}

/** Raised when REPLICATE_API_TOKEN isn't configured. Surfaced to the user with
 *  a clear "set the token" message rather than a generic 502. */
export class ReplicateNotConfiguredError extends Error {
  constructor() {
    super("Replicate API token not configured. Ask the admin to set the REPLICATE_API_TOKEN secret.");
    this.name = "ReplicateNotConfiguredError";
  }
}

interface ReplicatePrediction {
  id?: string;
  status?: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

/** Normalise the model's `output` field to a single image URL. nano-banana
 *  returns either a string URL or an array of URLs; take the first. */
function firstOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output.find((o) => typeof o === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

function mediaTypeForFormat(outputFormat: string): string {
  return outputFormat === "png" ? "image/png" : "image/jpeg";
}

/**
 * Generate or edit an image via Replicate. When `images` is non-empty the call
 * is an edit (images passed as `image_input`); otherwise it's text-to-image.
 *
 * @throws ReplicateNotConfiguredError when the token is missing.
 * @throws Error on API failure / timeout / unusable output.
 */
export async function runReplicateImage(opts: {
  env: Env;
  model: string;
  prompt: string;
  images?: ReplicateImageInput[];
  /** Output format. nano-banana supports "jpg" | "png". Default "jpg". */
  outputFormat?: "jpg" | "png";
}): Promise<ReplicateImageResult> {
  const token = opts.env.REPLICATE_API_TOKEN;
  if (!token) throw new ReplicateNotConfiguredError();

  const model = opts.model.trim();
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    throw new Error(`Invalid Replicate model id: "${model}" (expected "owner/name")`);
  }

  const outputFormat = opts.outputFormat ?? "jpg";
  const input: Record<string, unknown> = { prompt: opts.prompt, output_format: outputFormat };
  if (opts.images && opts.images.length > 0) {
    input[IMAGE_INPUT_FIELD] = opts.images.map((img) => `data:${img.mediaType};base64,${img.data}`);
  }

  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Official models support the model-scoped predictions endpoint, which
  // resolves the latest version server-side — no version hash to pin.
  const createRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: { ...authHeaders, Prefer: "wait" },
    body: JSON.stringify({ input }),
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw new Error(`Replicate API error (${createRes.status}): ${text.slice(0, 300)}`);
  }

  let prediction = (await createRes.json()) as ReplicatePrediction;

  // Poll if `Prefer: wait` returned before the prediction was terminal.
  const deadline = Date.now() + MAX_WAIT_MS;
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
    if (Date.now() > deadline) throw new Error("Replicate prediction timed out");
    const getUrl = prediction.urls?.get;
    if (!getUrl) throw new Error("Replicate prediction is not terminal and exposes no poll URL");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(getUrl, { headers: authHeaders });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      throw new Error(`Replicate poll error (${pollRes.status}): ${text.slice(0, 300)}`);
    }
    prediction = (await pollRes.json()) as ReplicatePrediction;
  }

  if (prediction.status !== "succeeded") {
    const detail = typeof prediction.error === "string" ? prediction.error : prediction.status;
    throw new Error(`Replicate prediction ${prediction.status}: ${String(detail).slice(0, 300)}`);
  }

  const url = firstOutputUrl(prediction.output);
  if (!url) throw new Error("Replicate succeeded but returned no image URL");

  // Fetch the produced image and return its bytes as base64 so the caller can
  // persist to R2 (Replicate output URLs expire ~1h).
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Failed to download Replicate output (${imgRes.status})`);
  const buf = await imgRes.arrayBuffer();
  const imageBase64 = bytesToBase64(new Uint8Array(buf));

  // Prefer the served content-type when present; else derive from outputFormat.
  const ct = imgRes.headers.get("content-type");
  const mediaType = ct && ct.startsWith("image/") ? ct.split(";")[0] : mediaTypeForFormat(outputFormat);

  return { imageBase64, mediaType };
}

/** Base64-encode bytes without blowing the stack on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
