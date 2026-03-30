import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ─── Types ───

export interface McpGatekeeperConfig {
  id: string;
  name: string;
  type: "http" | "service-binding";
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

export interface McpGatekeeper {
  connect(): Promise<void>;
  disconnect(): void;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<McpToolResult>;
  testConnection(): Promise<{ ok: boolean; toolCount?: number; error?: string }>;
  isConnected(): boolean;
}

// ─── HTTP MCP Gatekeeper ───

/**
 * HTTP MCP Gatekeeper — wraps a remote MCP server via Streamable HTTP transport.
 * Uses @modelcontextprotocol/sdk Client to connect and communicate.
 */
export class HttpMcpGatekeeper implements McpGatekeeper {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private cachedTools: McpToolInfo[] | null = null;

  constructor(private config: McpGatekeeperConfig) {
    if (config.type !== "http") {
      throw new Error(`HttpMcpGatekeeper only supports type "http", got "${config.type}"`);
    }
    if (!config.url) {
      throw new Error("HttpMcpGatekeeper requires a url");
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const url = new URL(this.config.url!);
    const requestInit: RequestInit = {};
    if (this.config.headers && Object.keys(this.config.headers).length > 0) {
      requestInit.headers = { ...this.config.headers };
    }

    this.transport = new StreamableHTTPClientTransport(url, { requestInit });
    this.client = new Client(
      { name: `dodo-gatekeeper-${this.config.id}`, version: "1.0.0" },
      { capabilities: {} },
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

  isConnected(): boolean {
    return this.connected;
  }
}
