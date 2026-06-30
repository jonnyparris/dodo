/**
 * Unit tests for mapReplicateCollectionModel — maps a Replicate collection
 * entry into the {id, label} shape that feeds the "Image model" autocomplete
 * datalist (src/shared-index.ts).
 */
import { describe, expect, it } from "vitest";
import { mapReplicateCollectionModel } from "../src/shared-index";

describe("mapReplicateCollectionModel", () => {
  it("builds owner/name id with a truncated description label", () => {
    const out = mapReplicateCollectionModel({
      owner: "google",
      name: "nano-banana-2",
      description: "Google's fast image generation model with conversational editing, multi-image fusion, and more",
    });
    expect(out?.id).toBe("google/nano-banana-2");
    expect(out?.label.startsWith("google/nano-banana-2 — ")).toBe(true);
    expect(out!.label.length).toBeLessThanOrEqual("google/nano-banana-2 — ".length + 71);
  });

  it("falls back to the bare id when there's no description", () => {
    expect(mapReplicateCollectionModel({ owner: "black-forest-labs", name: "flux-kontext-pro" })).toEqual({
      id: "black-forest-labs/flux-kontext-pro",
      label: "black-forest-labs/flux-kontext-pro",
    });
  });

  it("returns null when owner or name is missing", () => {
    expect(mapReplicateCollectionModel({ name: "x" })).toBeNull();
    expect(mapReplicateCollectionModel({ owner: "y" })).toBeNull();
    expect(mapReplicateCollectionModel({})).toBeNull();
  });

  it("trims whitespace in owner/name", () => {
    expect(mapReplicateCollectionModel({ owner: " a ", name: " b " })?.id).toBe("a/b");
  });
});
