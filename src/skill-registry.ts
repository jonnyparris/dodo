/**
 * Skill registry — Claude Code / OpenCode-compatible SKILL.md loader.
 *
 * Skills are static markdown documents the model can load on demand to
 * pick up specialized instructions. Three sources, merged into one map
 * keyed by `name` (last write wins, with a warning logged on collisions):
 *
 *   1. PERSONAL  — UserControl DO SQLite, scoped per-user. Editable via
 *                  MCP tools (`skill_write`, `skill_delete`) and HTTP routes.
 *   2. WORKSPACE — SKILL.md files inside the cloned workspace, scanned
 *                  from `.dodo/skills/`, `.claude/skills/`, `.agents/skills/`,
 *                  `.opencode/skill/`, `.opencode/skills/`. Read-only — to
 *                  edit, promote to personal via `skill_import_workspace`.
 *   3. BUILTIN   — Shipped with Dodo (`src/builtin-skills/*.md`).
 *
 * Two-stage progressive disclosure mirrors the OpenCode/Claude pattern:
 *   - Session start: inject only `name + description` per skill into the
 *     system prompt as `<available_skills>...</available_skills>`. ~150
 *     tokens per skill, capped to a budget.
 *   - On demand: model invokes the `skill` tool with a name; we return
 *     the full SKILL.md body plus a list of bundled file paths (lazy-loaded
 *     by the model via the regular `read` tool).
 *
 * Bundled assets live in R2 under `skills/{userId}/{skillName}/...` for
 * personal skills. Workspace skills load assets directly from the workspace
 * filesystem.
 */

import type { Workspace } from "@cloudflare/shell";

// ─── Types ───

export type SkillSource = "personal" | "workspace" | "builtin";

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: SkillSource;
  /** Stable URI describing where the skill came from (logged for diagnostics). */
  location: string;
  /** Relative paths of bundled files (references/, scripts/, assets/). */
  assetPaths: string[];
  /** Whether the skill is enabled (only personal skills can be disabled). */
  enabled: boolean;
  /** Original raw frontmatter, preserved for round-tripping on export. */
  rawFrontmatter?: Record<string, unknown>;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
  rawFrontmatter?: Record<string, unknown>;
}

// ─── Constants ───

/** Hard cap on bytes per skill body. Larger bodies are truncated with notice. */
const MAX_BODY_BYTES = 32_000;
/** Hard cap on description length (matches Claude Skills + OpenCode). */
const MAX_DESCRIPTION_CHARS = 1024;
/** Hard cap on name length (matches Claude Skills). */
const MAX_NAME_CHARS = 64;
/** Token budget for the rendered manifest section in the system prompt. */
const MAX_MANIFEST_BYTES = 4_000;
/** Cap on bundled-file listing returned by the `skill` tool. */
const MAX_LISTED_ASSETS = 25;

/** Workspace directories scanned for SKILL.md, in precedence order. */
export const WORKSPACE_SKILL_DIRS = [
  ".dodo/skills",
  ".claude/skills",
  ".agents/skills",
  ".opencode/skill",
  ".opencode/skills",
] as const;

// ─── Frontmatter parsing ───

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFrontmatterError";
  }
}

/**
 * Parse a SKILL.md file. Returns the frontmatter object + body string.
 * Throws SkillFrontmatterError if the document doesn't start with `---`
 * or the YAML is malformed for the fields we care about (`name`,
 * `description`).
 *
 * Deliberately permissive: we only validate the two required fields and
 * preserve extra fields verbatim. Full YAML support isn't needed — the
 * SKILL.md frontmatter convention only uses scalar strings in practice.
 */
export function parseSkillFile(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const trimmed = raw.replace(/^\uFEFF/, ""); // strip BOM
  if (!trimmed.startsWith("---")) {
    throw new SkillFrontmatterError("SKILL.md must start with YAML frontmatter (---)");
  }
  // Find the closing --- on its own line.
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    throw new SkillFrontmatterError("SKILL.md frontmatter has no closing ---");
  }
  const fmText = trimmed.slice(3, end).trim();
  // Body starts after the closing --- line.
  let body = trimmed.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);

  const frontmatter = parseSimpleYaml(fmText);
  return { frontmatter, body };
}

/**
 * Tiny YAML parser tailored to SKILL.md frontmatter. Handles:
 *   - `key: value` (single-line scalar)
 *   - `key: |` or `key: >` (block scalars, value is the indented block)
 *   - `key:` followed by `  - item` lines (string arrays, used for tags)
 *   - Quoted strings (`"..."` or `'...'`)
 *
 * Anything more complex returns the raw text as a string. Callers that
 * need richer parsing can ship their own — we don't pull in `yaml` to
 * keep the bundle small.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    const rest = match[2];

    if (rest === "|" || rest === ">") {
      // Block scalar — collect indented lines.
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (/^\s+/.test(ln) || ln === "") {
          blockLines.push(ln.replace(/^\s{0,4}/, ""));
          i++;
        } else {
          break;
        }
      }
      out[key] = blockLines.join(rest === "|" ? "\n" : " ").trim();
      continue;
    }

    if (rest === "" || rest === "[]") {
      // Could be an array on following lines.
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        const arr = /^\s*-\s*(.*)$/.exec(ln);
        if (arr) {
          items.push(unquote(arr[1].trim()));
          i++;
        } else {
          break;
        }
      }
      out[key] = items;
      continue;
    }

    // Inline scalar (possibly quoted).
    out[key] = unquote(rest.trim());
    i++;
  }
  return out;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Validate frontmatter fields and normalize them into a SkillInput. Throws
 * SkillFrontmatterError on missing/invalid required fields.
 */
export function normalizeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  options: { dirName?: string } = {},
): SkillInput {
  const nameRaw = frontmatter.name;
  if (typeof nameRaw !== "string" || !nameRaw) {
    throw new SkillFrontmatterError("SKILL.md frontmatter missing required `name`");
  }
  const name = nameRaw.trim();
  if (!NAME_PATTERN.test(name)) {
    throw new SkillFrontmatterError(
      `Invalid skill name "${name}" — must be lowercase letters, digits, hyphens or underscores, starting with letter/digit`,
    );
  }
  if (name.length > MAX_NAME_CHARS) {
    throw new SkillFrontmatterError(`Skill name exceeds ${MAX_NAME_CHARS} chars`);
  }
  if (options.dirName && options.dirName !== name) {
    // Loose match — log a warning but don't throw. OpenCode is strict here;
    // we're more forgiving so imported third-party skills don't fail.
    console.warn(
      `SKILL.md name "${name}" doesn't match directory "${options.dirName}" — proceeding anyway`,
    );
  }

  const descRaw = frontmatter.description;
  if (typeof descRaw !== "string" || !descRaw.trim()) {
    throw new SkillFrontmatterError("SKILL.md frontmatter missing required `description`");
  }
  const description = descRaw.trim().slice(0, MAX_DESCRIPTION_CHARS);

  // Strip body to size cap with middle-truncation notice (matches the
  // pattern used for project instructions in coding-agent.ts).
  let safeBody = body.trim();
  if (safeBody.length > MAX_BODY_BYTES) {
    const head = safeBody.slice(0, Math.floor(MAX_BODY_BYTES * 0.7));
    const tail = safeBody.slice(-Math.floor(MAX_BODY_BYTES * 0.2));
    const removed = safeBody.length - head.length - tail.length;
    safeBody = `${head}\n\n[... truncated ${removed} bytes ...]\n\n${tail}`;
  }

  return {
    name,
    description,
    body: safeBody,
    rawFrontmatter: { ...frontmatter },
  };
}

// ─── Manifest rendering ───

/**
 * Render the `<available_skills>` block injected into the system prompt.
 * Format mirrors OpenCode verbatim so model behaviour is consistent across
 * tools.
 *
 * Skills are sorted by source (personal → workspace → builtin) then by
 * name. If the total rendered size exceeds MAX_MANIFEST_BYTES, lower-priority
 * entries are dropped with a `<truncated/>` marker.
 */
export function renderManifest(skills: Skill[]): string {
  const sorted = [...skills]
    .filter((s) => s.enabled)
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name));

  const intro = [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the `skill` tool to load a skill when a task matches its description.",
    "Skills are inert until loaded — only `name` and `description` are visible right now.",
    "<available_skills>",
  ];
  const closing = "</available_skills>";

  const entries: string[] = [];
  let bytesUsed = intro.join("\n").length + closing.length + 2;
  let truncated = 0;

  for (const skill of sorted) {
    const entry = [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <source>${skill.source}</source>`,
      "  </skill>",
    ].join("\n");

    if (bytesUsed + entry.length + 1 > MAX_MANIFEST_BYTES) {
      truncated = sorted.length - entries.length;
      break;
    }
    entries.push(entry);
    bytesUsed += entry.length + 1;
  }

  if (entries.length === 0) return "";

  const parts = [...intro, ...entries];
  if (truncated > 0) {
    parts.push(`  <truncated count="${truncated}"/>`);
  }
  parts.push(closing);
  return parts.join("\n");
}

function sourceRank(s: SkillSource): number {
  switch (s) {
    case "personal": return 0;
    case "workspace": return 1;
    case "builtin": return 2;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Tool output rendering ───

/**
 * Format the output of the `skill` tool — full body + sampled file list.
 * Same shape OpenCode emits so a model that's seen one will recognize the other.
 */
export function renderSkillContent(skill: Skill): string {
  const lines: string[] = [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    `Source: ${skill.source} (${skill.location})`,
  ];

  if (skill.assetPaths.length > 0) {
    const sampled = skill.assetPaths.slice(0, MAX_LISTED_ASSETS);
    lines.push("");
    lines.push("Bundled files (NOT auto-loaded — use the `read` tool to fetch):");
    lines.push("<skill_files>");
    for (const path of sampled) {
      lines.push(`  <file>${escapeXml(path)}</file>`);
    }
    if (skill.assetPaths.length > sampled.length) {
      lines.push(`  <truncated count="${skill.assetPaths.length - sampled.length}"/>`);
    }
    lines.push("</skill_files>");
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

// ─── Workspace scan ───

/**
 * Walk the workspace looking for SKILL.md files in the conventional
 * directories. Returns parsed Skill records with source = "workspace".
 *
 * Best-effort: errors per-skill are logged and the skill is skipped, never
 * fatal. Capped at MAX_WORKSPACE_SKILLS to bound work on huge repos.
 */
const MAX_WORKSPACE_SKILLS = 50;

export async function scanWorkspaceSkills(workspace: Workspace): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const root of WORKSPACE_SKILL_DIRS) {
    const entries = await safeReadDir(workspace, `/${root}`);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.type !== "directory") continue;
      if (out.length >= MAX_WORKSPACE_SKILLS) break;
      const skillDir = `/${root}/${entry.name}`;
      const skill = await loadWorkspaceSkill(workspace, skillDir, entry.name);
      if (skill) out.push(skill);
    }
    // Also scan first-level subdirs of the workspace (e.g. cloned repos)
    // so a `git clone` of a repo with `.claude/skills/` works automatically.
    if (root === WORKSPACE_SKILL_DIRS[0]) {
      const rootEntries = await safeReadDir(workspace, "/");
      if (!rootEntries) continue;
      for (const repoEntry of rootEntries) {
        if (repoEntry.type !== "directory" || repoEntry.name.startsWith(".")) continue;
        for (const innerRoot of WORKSPACE_SKILL_DIRS) {
          const innerEntries = await safeReadDir(workspace, `/${repoEntry.name}/${innerRoot}`);
          if (!innerEntries) continue;
          for (const entry of innerEntries) {
            if (entry.type !== "directory") continue;
            if (out.length >= MAX_WORKSPACE_SKILLS) break;
            const skillDir = `/${repoEntry.name}/${innerRoot}/${entry.name}`;
            const skill = await loadWorkspaceSkill(workspace, skillDir, entry.name);
            if (skill) out.push(skill);
          }
        }
      }
    }
  }
  return out;
}

async function loadWorkspaceSkill(
  workspace: Workspace,
  dir: string,
  dirName: string,
): Promise<Skill | null> {
  // Look for SKILL.md (canonical) — also try lowercase as a fallback.
  let raw: string | null = null;
  let path = `${dir}/SKILL.md`;
  raw = await safeReadFile(workspace, path);
  if (raw === null) {
    path = `${dir}/skill.md`;
    raw = await safeReadFile(workspace, path);
  }
  if (raw === null) return null;

  try {
    const { frontmatter, body } = parseSkillFile(raw);
    const input = normalizeFrontmatter(frontmatter, body, { dirName });

    // Sample bundled files relative to skill dir, depth 2.
    const assetPaths: string[] = [];
    await collectAssets(workspace, dir, "", assetPaths, 2);

    return {
      name: input.name,
      description: input.description,
      body: input.body,
      source: "workspace",
      location: path,
      assetPaths,
      enabled: true, // workspace skills enabled by default
      rawFrontmatter: input.rawFrontmatter,
    };
  } catch (error) {
    console.warn(`skill-load-failed dir=${dir}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function collectAssets(
  workspace: Workspace,
  base: string,
  prefix: string,
  out: string[],
  remainingDepth: number,
): Promise<void> {
  if (remainingDepth < 0 || out.length >= MAX_LISTED_ASSETS) return;
  const dir = prefix ? `${base}/${prefix}` : base;
  const entries = await safeReadDir(workspace, dir);
  if (!entries) return;
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_ASSETS) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "file") {
      // Skip the SKILL.md itself — already returned in the body.
      if (rel === "SKILL.md" || rel === "skill.md") continue;
      out.push(rel);
    } else if (entry.type === "directory") {
      await collectAssets(workspace, base, rel, out, remainingDepth - 1);
    }
  }
}

async function safeReadDir(
  workspace: Workspace,
  path: string,
): Promise<Array<{ name: string; type: string }> | null> {
  try {
    const entries = await workspace.readDir(path);
    return entries as Array<{ name: string; type: string }>;
  } catch {
    return null;
  }
}

async function safeReadFile(workspace: Workspace, path: string): Promise<string | null> {
  try {
    const out = await workspace.readFile(path);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

// ─── HTTP-backed personal skills ───

/**
 * Wraps a UserControl DO stub with the personal-skill HTTP endpoints
 * defined in `user-control.ts`. Used by the registry layer in
 * coding-agent so per-user skills are scoped to the user's DO.
 */
export interface PersonalSkillClient {
  list(): Promise<Skill[]>;
  get(name: string): Promise<Skill | null>;
  put(input: SkillInput): Promise<Skill>;
  delete(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
}

export function createPersonalSkillClient(
  stub: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
): PersonalSkillClient {
  const base = "https://user-control/skills";
  return {
    async list(): Promise<Skill[]> {
      const res = await stub.fetch(base);
      if (!res.ok) return [];
      const { skills } = (await res.json()) as { skills: Skill[] };
      return skills;
    },
    async get(name: string): Promise<Skill | null> {
      const res = await stub.fetch(`${base}/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      return (await res.json()) as Skill;
    },
    async put(input: SkillInput): Promise<Skill> {
      const res = await stub.fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`skill put failed: ${err}`);
      }
      return (await res.json()) as Skill;
    },
    async delete(name: string): Promise<void> {
      await stub.fetch(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    async setEnabled(name: string, enabled: boolean): Promise<void> {
      await stub.fetch(`${base}/${encodeURIComponent(name)}/enabled`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    },
  };
}

// ─── Registry ───

/**
 * Merge skills from all sources into a deduplicated list. Earlier sources
 * win — personal > workspace > builtin. Returns a stable, sorted list.
 */
export function mergeSkills(...sources: Skill[][]): Skill[] {
  const map = new Map<string, Skill>();
  for (const list of sources) {
    for (const skill of list) {
      if (!map.has(skill.name)) {
        map.set(skill.name, skill);
      }
    }
  }
  return [...map.values()].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name),
  );
}

// ─── R2 asset storage for personal skills ───

/**
 * Asset prefix in WORKSPACE_BUCKET. Layout:
 *   skills/{userId}/{skillName}/{relativePath}
 * The body of the skill itself lives in DO SQLite; only bundled assets
 * (references/, scripts/, etc.) hit R2.
 */
export function assetPrefix(userId: string, skillName: string): string {
  return `skills/${userId}/${skillName}/`;
}

export async function listSkillAssets(
  bucket: R2Bucket,
  userId: string,
  skillName: string,
): Promise<string[]> {
  const prefix = assetPrefix(userId, skillName);
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await bucket.list({ prefix, limit: 200, cursor });
    for (const obj of result.objects) {
      out.push(obj.key.slice(prefix.length));
    }
    if (!result.truncated) break;
    cursor = result.cursor;
    if (out.length >= MAX_LISTED_ASSETS * 4) break;
  }
  return out.slice(0, MAX_LISTED_ASSETS);
}

export async function putSkillAsset(
  bucket: R2Bucket,
  userId: string,
  skillName: string,
  relativePath: string,
  body: ArrayBuffer | string,
): Promise<void> {
  const safe = relativePath.replace(/^\/+/, "").replace(/\.\./g, "");
  await bucket.put(`${assetPrefix(userId, skillName)}${safe}`, body);
}

export async function deleteSkillAssets(
  bucket: R2Bucket,
  userId: string,
  skillName: string,
): Promise<void> {
  const keys = await listSkillAssets(bucket, userId, skillName);
  if (keys.length === 0) return;
  await Promise.all(
    keys.map((rel) => bucket.delete(`${assetPrefix(userId, skillName)}${rel}`)),
  );
}
