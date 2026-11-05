/** The pi client's model label (clients/pi/model-label.ts): running model first, the next prompt's model only when it differs. */
import { describe, expect, it } from "vitest";
import { formatModelLabel, modelLabel } from "../clients/pi/model-label";

describe("pi client model label", () => {
  it("idle: shows the next prompt's model — override, else the owner's default, else the session's", () => {
    expect(modelLabel({ status: "idle", model: "a", modelOverride: { model: "b" } }, "c")).toEqual({ current: "b", nextSource: "session override" });
    expect(modelLabel({ status: "idle", model: "a" }, "c")).toEqual({ current: "c", nextSource: "default" });
    expect(modelLabel({ status: "idle", model: "a" }, undefined)).toEqual({ current: "a", nextSource: "default" });
    expect(modelLabel(undefined, undefined).current).toBe("?");
    expect(modelLabel({ status: "idle", model: "" }, undefined).current).toBe("?");
  });

  it("running with an override set mid-run: the running model, then the pending one as next", () => {
    const label = modelLabel({ status: "running", model: "a", modelOverride: { model: "b" } }, "a");
    expect(label).toEqual({ current: "a", next: "b", nextSource: "session override" });
    expect(formatModelLabel(label)).toBe("a → b");
  });

  it("running with the override cleared mid-run: the cleared model is still running, the default is next", () => {
    expect(modelLabel({ status: "running", model: "b" }, "a")).toEqual({ current: "b", next: "a", nextSource: "default" });
  });

  it("running on the model the next prompt uses too: no next", () => {
    const label = modelLabel({ status: "running", model: "b", modelOverride: { model: "b" } }, "a");
    expect(label).toEqual({ current: "b", nextSource: "session override" });
    expect(formatModelLabel(label)).toBe("b");
  });

  it("running without a reported model: '?' now, not the next prompt's model", () => {
    expect(modelLabel({ status: "running", model: "", modelOverride: { model: "b" } }, "a")).toEqual({ current: "?", next: "b", nextSource: "session override" });
  });

  it("prefers the server's nextModel (resolved against the owner's config) over the requester's default", () => {
    expect(modelLabel({ status: "running", model: "b", nextModel: "owner-default" }, "my-default")).toEqual({ current: "b", next: "owner-default", nextSource: "default" });
    expect(modelLabel({ status: "running", model: "b", nextModel: "b" }, "my-default")).toEqual({ current: "b", nextSource: "default" });
    expect(modelLabel({ status: "idle", model: "b", nextModel: "b" }, "my-default").current).toBe("b");
  });

  it("running without a reported model and no override: '?' now, the default next", () => {
    expect(modelLabel({ status: "running", model: "" }, "a")).toEqual({ current: "?", next: "a", nextSource: "default" });
  });
});
