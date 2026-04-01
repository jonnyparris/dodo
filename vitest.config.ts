import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Only run tests from the test/ directory (exclude node_modules test files)
    include: ["test/**/*.test.ts"],
    // Tests that import the main worker module fail because workerd can't
    // resolve the re-export chain: @cloudflare/think → ai → @ai-sdk/provider-utils.
    // Static ESM imports are processed before vi.mock() intercepts, so mocking
    // doesn't help. Only pure unit tests (no worker import) pass.
    // TODO: Fix upstream — either @cloudflare/think imports from @ai-sdk/provider-utils
    // directly, or vitest-pool-workers pre-bundles the ai SDK dependency tree.
    exclude: [
      "test/admin.test.ts",
      "test/architecture-gaps.test.ts",
      "test/browser.test.ts",
      "test/dodo.test.ts",
      "test/feature-gaps.test.ts",
      "test/mcp-config.test.ts",
      "test/multi-tenancy.test.ts",
      "test/onboarding.test.ts",
      "test/permission-enforcement.test.ts",
      "test/rate-limits.test.ts",
      "test/realtime.test.ts",
      "test/shared-index.test.ts",
      "test/sharing.test.ts",
      "test/user-control.test.ts",
    ],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
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
            SECRETS_MASTER_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ADMIN_EMAIL: "admin@test.local",
            COOKIE_SECRET: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
          }
        }
      }
    }
  }
});
