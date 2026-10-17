/**
 * Byte-safe redirects for the `shell` tool.
 *
 * just-bash pipes carry bytes as latin1 strings (one char = one byte) and
 * redirects call `fs.writeFile(path, stdout, "binary")`. @cloudflare/computer's
 * WorkspaceFsAdapter (≤ 0.5.1) ignores that encoding and writes the string as
 * UTF-8, so raw bytes ≥ 0x80 became two (0x89 -> C2 89): `base64 -d > x.png`,
 * `gzip -c > f.gz` etc. wrote corrupt files. (UTF-8 text survived.)
 *
 * The adapter runs inside the shell's Dynamic Worker, built from the string
 * module `shell.js`. WorkerShellBackend merges `commands` module groups over
 * the core modules, so we pass a patched `shell.js`. If the upstream source
 * changes shape the patch throws, and test/shell-binary-e2e.test.ts fails on
 * the bump; drop this file once upstream honours the encoding.
 */
import coreModules from "@cloudflare/computer/shell/core";

const WRITE_FILE = `  async writeFile(path, content, _options) {
    if (isDevNull(path)) return;
    await this.#fs.writeFile(path, content);
  }`;
const APPEND_ADDITION = `    const addition = typeof content === "string" ? new TextEncoder().encode(content) : content;`;

const HELPER = `
function __dodoEncodeContent(content, options) {
  if (typeof content !== "string") return content;
  const enc = typeof options === "string" ? options : options?.encoding;
  if (enc === "binary" || enc === "latin1") {
    const out = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) out[i] = content.charCodeAt(i) & 0xff;
    return out;
  }
  if (enc === "base64") return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  if (enc === "hex") {
    const out = new Uint8Array(content.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(content.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new TextEncoder().encode(content);
}
`;

type ModuleMap = Record<string, { js: string }>;

export function patchShellSource(src: string): string {
  if (src.includes("__dodoEncodeContent")) return src;
  const w = src.indexOf(WRITE_FILE);
  const a = src.indexOf(APPEND_ADDITION);
  if (w < 0 || a < 0 || src.indexOf(WRITE_FILE, w + 1) >= 0 || src.indexOf(APPEND_ADDITION, a + 1) >= 0) {
    throw new Error("shell-patch: @cloudflare/computer shell.js changed shape; re-check WorkspaceFsAdapter.writeFile/appendFile");
  }
  return (
    HELPER +
    src
      .replace(WRITE_FILE, `  async writeFile(path, content, options) {
    if (isDevNull(path)) return;
    await this.#fs.writeFile(path, __dodoEncodeContent(content, options));
  }`)
      .replace(APPEND_ADDITION, `    const addition = __dodoEncodeContent(content, _options);`)
  );
}

let cached: ModuleMap | undefined;

/** Module group for `WorkerShellBackend({ commands: [...] })`. */
export function byteSafeShellModules(): ModuleMap {
  if (!cached) {
    const core = coreModules as unknown as ModuleMap;
    cached = { "shell.js": { js: patchShellSource(core["shell.js"]!.js) } };
  }
  return cached;
}
