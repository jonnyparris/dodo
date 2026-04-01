import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
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
          DODO_VERSION: "0.3.0-test",
          NTFY_TOPIC: "",
          SECRETS_MASTER_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          ADMIN_EMAIL: "admin@test.local",
          COOKIE_SECRET:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"],
        },
      },
    },
  },
});
