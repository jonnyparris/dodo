import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/notify";

describe("renderTemplate", () => {
  const payload = {
    title: "Dodo: foo done",
    body: "Branch: x\nSession: y",
    priority: "high" as const,
    tags: "robot,white_check_mark",
    url: "https://example.com",
    ownerEmail: "owner@example.com",
  };

  it("substitutes known placeholders", () => {
    const result = renderTemplate("Title: {{title}} | Pri: {{priority}}", payload, false);
    expect(result).toBe("Title: Dodo: foo done | Pri: high");
  });

  it("substitutes empty string for missing optional fields", () => {
    const partial = { title: "x", body: "y" };
    const result = renderTemplate("{{title}}|{{tags}}|{{url}}|{{priority}}", partial, false);
    expect(result).toBe("x|||default");
  });

  it("leaves unknown placeholders empty", () => {
    const result = renderTemplate("{{title}}-{{nope}}", payload, false);
    expect(result).toBe("Dodo: foo done-");
  });

  it("produces valid JSON when jsonEscape=true and template is JSON", () => {
    // Template mirrors what a Signal config would look like
    const template = '{"message":"{{title}}\\n{{body}}","number":"+44","recipients":["+44"]}';
    const result = renderTemplate(template, payload, true);

    // Result must parse and contain the rendered message
    const parsed = JSON.parse(result) as { message: string; number: string; recipients: string[] };
    expect(parsed.message).toBe("Dodo: foo done\nBranch: x\nSession: y");
    expect(parsed.recipients).toEqual(["+44"]);
  });

  it("JSON-escapes quotes and backslashes inside values", () => {
    const dangerous = { title: 'has "quotes" and \\ backslash', body: "ok" };
    const template = '{"t":"{{title}}","b":"{{body}}"}';
    const result = renderTemplate(template, dangerous, true);

    // Without escaping this would be invalid JSON
    const parsed = JSON.parse(result) as { t: string; b: string };
    expect(parsed.t).toBe('has "quotes" and \\ backslash');
    expect(parsed.b).toBe("ok");
  });

  it("does not escape when jsonEscape=false", () => {
    const dangerous = { title: 'has "quotes"', body: "ok" };
    const result = renderTemplate("{{title}}", dangerous, false);
    expect(result).toBe('has "quotes"');
  });

  it("handles newlines in body for JSON templates", () => {
    const multiline = { title: "t", body: "line1\nline2\nline3" };
    const template = '{"b":"{{body}}"}';
    const result = renderTemplate(template, multiline, true);
    const parsed = JSON.parse(result) as { b: string };
    expect(parsed.b).toBe("line1\nline2\nline3");
  });
});
