import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Use the Workers-compatible JSON Schema validator. The SDK default
// (AjvJsonSchemaValidator) calls `new Function()` to compile schemas,
// which Cloudflare Workers blocks with "Code generation from strings
// disallowed for this context". This bites whenever a remote MCP server
// returns tools with an `outputSchema` — see Client.cacheToolMetadata in
// @modelcontextprotocol/sdk/client/index.js. (You.com's tools all carry
// outputSchema, which is why their MCP server's tools never appeared
// despite a working connect/initialize.)
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";

// ─── Auth header normalisation ───

/**
 * Normalise an `Authorization` header value so users who paste a bare API key
 * (the common footgun for static-headers MCP integrations) still get a valid
 * `Bearer <token>` header sent on the wire.
 *
 * Rules:
 * - If the value already starts with a recognised auth scheme (Bearer, Basic,
 *   Token, OAuth, Digest, etc. — anything matching `<scheme> <rest>` where
 *   scheme is letters/digits/`-`/`_`), leave it untouched.
 * - If the value is empty or whitespace-only, leave it as-is (let upstream 401).
 * - Otherwise prepend `Bearer `.
 *
 * Exported for unit testing.
 */
export function normaliseAuthorizationHeader(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return value;
  // Match `<scheme> <something>` where scheme is letters/digits/-/_ and there's
  // at least one space-separated token after. Case-insensitive on scheme name.
  if (/^[A-Za-z][A-Za-z0-9_-]*\s+\S/.test(trimmed)) return value;
  return `Bearer ${trimmed}`;
}

/**
 * Apply `normaliseAuthorizationHeader` to whichever header key matches
 * `Authorization` case-insensitively. Returns a new headers object; does not
 * mutate the input. Returns `{ headers, normalised }` so callers can decide
 * whether to log.
 */
export function normaliseAuthHeaders(
  headers: Record<string, string>,
): { headers: Record<string, string>; normalised: boolean } {
  const out: Record<string, string> = {};
  let normalised = false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      const next = normaliseAuthorizationHeader(value);
      if (next !== value) normalised = true;
      out[key] = next;
    } else {
      out[key] = value;
    }
  }
  return { headers: out, normalised };
}

// ─── Types ───

export interface McpClientConfig {
  id: string;
  name: string;
  type: "http" | "service-binding";
  /**
   * - `static_headers` — fixed bearer/API-key headers stored in encrypted_secrets
   * - `oauth` — Agents-SDK-managed OAuth (per-user hub DO). Filtered out of
   *   the static MCP gatekeeper path in coding-agent.ts.
   * - `refresh_token` — bearer token that auto-refreshes via OAuth refresh-token
   *   grant. Use when the OAuth provider only allows loopback redirect URIs
   *   (e.g. Cloudflare Portal) and DCR was performed by a local helper.
   */
  auth_type: "oauth" | "static_headers" | "refresh_token";
  url?: string;
  headers?: Record<string, string>;
  /** Header key names (without values) for display purposes. */
  headerKeys?: string[];
  enabled: boolean;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClient {
  connect(): Promise<void>;
  disconnect(): void;
  listTools(): Promise<McpToolInfo[]>;
  /** Return tools from cache without async call. Null if not yet listed. */
  getCachedTools(): McpToolInfo[] | null;
  callTool(name: string, args: unknown): Promise<McpToolResult>;
  testConnection(): Promise<{ ok: boolean; toolCount?: number; error?: string }>;
  isConnected(): boolean;
}

// ─── HTTP MCP Client ───

/**
 * HTTP MCP Client — wraps a remote MCP server via Streamable HTTP transport.
 * Uses @modelcontextprotocol/sdk Client to connect and communicate.
 */
export class HttpMcpClient implements McpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private cachedTools: McpToolInfo[] | null = null;
  private mcpDepth = 0;

  constructor(private config: McpClientConfig, mcpDepth = 0) {
    if (config.type !== "http") {
      throw new Error(`HttpMcpClient only supports type "http", got "${config.type}"`);
    }
    if (!config.url) {
      throw new Error("HttpMcpClient requires a url");
    }
    this.mcpDepth = mcpDepth;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const url = new URL(this.config.url!);
    const requestInit: RequestInit = {};
    let headers: Record<string, string> = {};
    if (this.config.headers && Object.keys(this.config.headers).length > 0) {
      Object.assign(headers, this.config.headers);
    }
    // Normalise Authorization header so bare-token values (a common
    // static-headers footgun) still produce a valid `Bearer <token>` header
    // on the wire.
    const norm = normaliseAuthHeaders(headers);
    headers = norm.headers;
    if (norm.normalised) {
      console.info(
        `[mcp] prepended "Bearer " to Authorization header for "${this.config.name}" (${this.config.id}) — stored value was missing an auth scheme`,
      );
    }
    // Propagate MCP recursion depth to outbound MCP servers
    if (this.mcpDepth > 0) {
      headers["x-dodo-mcp-depth"] = String(this.mcpDepth);
    }
    if (Object.keys(headers).length > 0) {
      requestInit.headers = headers;
    }

    this.transport = new StreamableHTTPClientTransport(url, { requestInit });
    this.client = new Client(
      { name: `dodo-client-${this.config.id}`, version: "1.0.0" },
      {
        capabilities: {},
        // Workers-safe validator — see the import comment above.
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  disconnect(): void {
    if (this.transport) {
      this.transport.close().catch(() => {});
      this.transport = null;
    }
    this.client = null;
    this.connected = false;
    this.cachedTools = null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (this.cachedTools) return this.cachedTools;
    if (!this.client || !this.connected) {
      throw new Error("Not connected. Call connect() first.");
    }

    const result = await this.client.listTools();
    const prefix = this.config.id;

    this.cachedTools = result.tools.map((tool) => ({
      name: `${prefix}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    return this.cachedTools;
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    if (!this.client || !this.connected) {
      throw new Error("Not connected. Call connect() first.");
    }

    // Strip the namespace prefix to get the original tool name
    const prefix = `${this.config.id}__`;
    const originalName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    const result = await this.client.callTool({
      name: originalName,
      arguments: args as Record<string, unknown>,
    });

    // Normalize the result — the SDK returns a union type
    if ("content" in result && Array.isArray(result.content)) {
      return {
        content: result.content.map((c) => ({
          type: c.type,
          text: "text" in c ? c.text : undefined,
        })),
        isError: "isError" in result ? !!result.isError : false,
      };
    }

    // Fallback for compatibility result format
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false,
    };
  }

  async testConnection(): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    try {
      await this.connect();
      const tools = await this.listTools();
      this.disconnect();
      return { ok: true, toolCount: tools.length };
    } catch (error) {
      this.disconnect();
      const message = error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: message };
    }
  }

  getCachedTools(): McpToolInfo[] | null {
    return this.cachedTools;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
