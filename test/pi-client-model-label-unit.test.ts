/** The pi client's model label (clients/pi/model-label.ts): running model first, the next prompt's model only when it differs. */
import { describe, expect, it } from "vitest";
import { formatModelLabel, modelLabel } from "../clients/pi/model-label";

describe("pi client model label", () => {
  it("idle: shows the next prompt's model — override, else the owner's default, else the session's", () => {
    expect(modelLabel({ status: "idle", model: "a", modelOverride: { model: "b" } }, "c")).toEqual({ current: "b", nextSource: "session override" });
    expect(modelLabel({ status: "idle", model: "a" }, "c")).toEqual({ current: "c", nextSource: "your default" });
    expect(modelLabel({ status: "idle", model: "a" }, undefined)).toEqual({ current: "a", nextSource: "your default" });
    expect(modelLabel(undefined, undefined).current).toBe("?");
  });

  it("running with an override set mid-run: the running model, then the pending one as next", () => {
    const label = modelLabel({ status: "running", model: "a", modelOverride: { model: "b" } }, "a");
    expect(label).toEqual({ current: "a", next: "b", nextSource: "session override" });
    expect(formatModelLabel(label)).toBe("a → b");
  });

  it("running with the override cleared mid-run: the cleared model is still running, the default is next", () => {
    expect(modelLabel({ status: "running", model: "b" }, "a")).toEqual({ current: "b", next: "a", nextSource: "your default" });
  });

  it("running on the model the next prompt uses too: no next", () => {
    const label = modelLabel({ status: "running", model: "b", modelOverride: { model: "b" } }, "a");
    expect(label).toEqual({ current: "b", nextSource: "session override" });
    expect(formatModelLabel(label)).toBe("b");
  });
});
