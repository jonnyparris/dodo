import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ALLOW_UNAUTHENTICATED_DEV: "true",
            CF_ACCESS_AUD: "test-audience",
            CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
            DEFAULT_MODEL: "claude-test",
            OPENCODE_BASE_URL: "https://mock-opencode.example/v1",
            AI_GATEWAY_BASE_URL: "https://mock-ai-gateway.example/v1",
            OPENCODE_GATEWAY_TOKEN: "opencode-token",
            AI_GATEWAY_KEY: "ai-gateway-key",
            DODO_MCP_TOKEN: "test-mcp-token",
            DODO_VERSION: "0.2.0-test",
            NTFY_TOPIC: ""
          }
        }
      }
    }
  }
});
