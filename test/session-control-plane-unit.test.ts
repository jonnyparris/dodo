import { describe, expect, it } from "vitest";
import {
  createInMemoryMetadataKv,
  createSessionControlPlane,
} from "../src/session-control-plane";

describe("SessionControlPlane", () => {
  it("returns defaults when nothing is set", () => {
    const cp = createSessionControlPlane(createInMemoryMetadataKv());
    const snap = cp.read();
    expect(snap.sessionId).toBeNull();
    expect(snap.status).toBe("idle");
    expect(snap.activePromptId).toBeNull();
    expect(snap.title).toBeNull();
  });

  it("ensureBootstrap stamps session_id, created_at, updated_at, owner_email, status=idle", () => {
    const kv = createInMemoryMetadataKv();
    const cp = createSessionControlPlane(kv);
    cp.ensureBootstrap("sess-1", "alice@example.com");
    expect(kv.read("session_id")).toBe("sess-1");
    expect(kv.read("owner_email")).toBe("alice@example.com");
    expect(kv.read("status")).toBe("idle");
    expect(kv.read("created_at")).toBeTruthy();
    expect(kv.read("updated_at")).toBeTruthy();
  });

  it("ensureBootstrap does not overwrite existing session_id or owner_email", () => {
    const kv = createInMemoryMetadataKv({
      session_id: "original",
      owner_email: "first@example.com",
      created_at: "2020-01-01T00:00:00.000Z",
    });
    const cp = createSessionControlPlane(kv);
    cp.ensureBootstrap("new-id", "second@example.com");
    expect(kv.read("session_id")).toBe("original");
    expect(kv.read("owner_email")).toBe("first@example.com");
    expect(kv.read("created_at")).toBe("2020-01-01T00:00:00.000Z");
  });

  it("beginPrompt sets active id, status=running, and title-when-missing", () => {
    const kv = createInMemoryMetadataKv();
    const cp = createSessionControlPlane(kv);
    cp.beginPrompt("prompt-1", "First prompt");
    expect(kv.read("active_prompt_id")).toBe("prompt-1");
    expect(kv.read("status")).toBe("running");
    expect(kv.read("title")).toBe("First prompt");
  });

  it("beginPrompt does not overwrite an existing title", () => {
    const kv = createInMemoryMetadataKv({ title: "Old title" });
    const cp = createSessionControlPlane(kv);
    cp.beginPrompt("prompt-2", "New title");
    expect(kv.read("title")).toBe("Old title");
  });

  it("endPrompt clears active_prompt_id and sets status=idle", () => {
    const kv = createInMemoryMetadataKv({
      active_prompt_id: "prompt-x",
      status: "running",
    });
    const cp = createSessionControlPlane(kv);
    cp.endPrompt();
    expect(kv.read("active_prompt_id")).toBeNull();
    expect(kv.read("status")).toBe("idle");
  });

  it("snapshot reflects current state", () => {
    const kv = createInMemoryMetadataKv({
      session_id: "sess-2",
      status: "running",
      active_prompt_id: "p-1",
      title: "Hello",
      owner_email: "bob@example.com",
    });
    const cp = createSessionControlPlane(kv);
    const snap = cp.read();
    expect(snap).toMatchObject({
      sessionId: "sess-2",
      status: "running",
      activePromptId: "p-1",
      title: "Hello",
      ownerEmail: "bob@example.com",
    });
  });
});
