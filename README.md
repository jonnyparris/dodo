# Dodo

<p align="center">
  <img src="assets/dodo.svg" alt="Dodo" width="120"/>
</p>

<p align="center">
  Coding agent platform on Cloudflare Workers.<br/>
  Deploy to your Cloudflare account, connect any LLM, and dispatch autonomous sessions from a browser or MCP client.
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/jonnyparris/dodo">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/>
  </a>
</p>

## What is Dodo?

Dodo is a coding agent platform built on Cloudflare Workers. Each session runs in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with persistent files, git, a chat loop backed by [`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think), and sandboxed code execution. You bring the LLM — Dodo handles the rest.

It deploys to your Cloudflare account. You pick the model, you control costs, and your data stays in your account.

## Quick start

### One-click deploy

Click the **Deploy to Cloudflare** button above. Cloudflare will fork the repo, provision resources (Durable Objects, R2, Workers AI, Browser Rendering), and deploy. You'll be prompted for secrets during setup — the only required one is `ADMIN_EMAIL`. See [Secrets](#secrets) for the full list.

After deploy, visit the URL — you'll be logged in as the admin.

### Manual deploy

```bash
git clone https://github.com/jonnyparris/dodo.git
cd dodo
npm install

# Set the one required secret — your email:
wrangler secret put ADMIN_EMAIL

# Optional but recommended:
wrangler secret put SECRETS_MASTER_KEY      # openssl rand -hex 32
wrangler secret put COOKIE_SECRET           # openssl rand -hex 32
wrangler secret put DODO_MCP_TOKEN          # openssl rand -base64url 32
wrangler secret put OPENCODE_GATEWAY_TOKEN  # your LLM gateway token

# Deploy
npm run deploy
```

### Local development

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your secrets
npm run dev
```

The dev server uses `wrangler.dev.jsonc` with `ALLOW_UNAUTHENTICATED_DEV=true` to bypass Cloudflare Access locally.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan for Durable Objects)
- An LLM gateway token — either [OpenCode](https://opencode.cloudflare.dev) or [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- Optional: [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) for multi-user deployments (see [Authentication](#authentication))

## Features

| Category | What you get |
|----------|-------------|
| **Sessions** | Create, fork, soft-delete (5-min recovery), share with read/write permissions |
| **Chat** | Sync and async prompts, SSE streaming, fiber-backed recovery across DO evictions |
| **Workspace** | File CRUD, glob search, in-file replace via `@cloudflare/shell` (SQLite + R2 spill) |
| **Code execution** | Sandboxed JS with workspace filesystem, git, and gated outbound fetch |
| **Git** | Clone, commit, push, pull, branch, diff — automatic token injection for GitHub/GitLab |
| **Scheduling** | Delayed, datetime, cron, and interval jobs that dispatch prompts automatically |
| **Task board** | Kanban with drag-and-drop, batch dispatch, auto-sync when sessions complete |
| **Memory** | Per-user key-value store with text search, persistent across sessions |
| **MCP** | 46-tool server at `/mcp` for orchestration; 2-tool code-mode at `/mcp/codemode` for agents |
| **Orchestration** | Seed sessions, deterministic edit pipelines, worker dispatch with branch verification |
| **Browser** | Headless Chrome via native binding (admin) or user-supplied credentials (MCP). Navigate pages, read docs, scrape data. |
| **Security** | Optional CF Access auth, user allowlist, envelope-encrypted secrets, gated sandbox networking |
| **UI** | Three-panel responsive web app with real-time streaming, presence, and dark mode |

## Connecting your LLM

Dodo routes LLM calls through a configurable gateway. After deploying, open the UI and set your model and gateway in the sidebar config panel.

| Gateway | Setup |
|---------|-------|
| **OpenCode** | Set `OPENCODE_GATEWAY_TOKEN` as a secret. Models populate automatically. |
| **AI Gateway** | Set `AI_GATEWAY_KEY` as a secret. Set `AI_GATEWAY_BASE_URL` in wrangler.jsonc vars. |

The model ID format is `provider/model` (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o`). You can switch models per-session from the UI.

## Connecting via MCP

Dodo exposes two MCP endpoints. Use `/mcp/codemode` for coding agents (minimal context) and `/mcp` for orchestrators that need full control.

| Endpoint | Tools | Best for |
|----------|-------|----------|
| `/mcp` | 46 | Orchestrators — sessions, tasks, git, memory, orchestration |
| `/mcp/codemode` | 2 | Coding agents — `search` + `execute` (~1k tokens context) |

**Example config** (OpenCode, Claude Desktop, or any MCP client):

```json
{
  "mcp": {
    "dodo": {
      "type": "remote",
      "url": "https://your-dodo.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_DODO_MCP_TOKEN"
      }
    }
  }
}
```

## Secrets

Set via `wrangler secret put <NAME>` or through the Deploy to Cloudflare flow.

| Secret | Required | Purpose |
|--------|----------|---------|
| `ADMIN_EMAIL` | **Yes** | Your email address. Auto-added to the allowlist on first request. |
| `SECRETS_MASTER_KEY` | Recommended | 32-byte hex key for envelope encryption of per-user secrets |
| `COOKIE_SECRET` | Recommended | Signs session-sharing cookies |
| `DODO_MCP_TOKEN` | Recommended | Bearer token for `/mcp` and `/mcp/codemode` |
| `OPENCODE_GATEWAY_TOKEN` | If using OpenCode | Auth token for the OpenCode gateway |
| `AI_GATEWAY_KEY` | If using AI Gateway | Auth key for the AI Gateway |
| `CF_ACCESS_AUD` | If using Access | Cloudflare Access application audience tag |
| `CF_ACCESS_TEAM_DOMAIN` | If using Access | Cloudflare Access team domain URL |

Per-user secrets (GitHub token, GitLab token, ntfy topic) are stored encrypted in each user's Durable Object after passkey onboarding — not as environment variables.

## Authentication

Dodo supports two modes:

**Single-user (default).** Set `ADMIN_EMAIL` and you're done. Every request is authenticated as the admin. No login page, no external auth provider. Good for personal deployments.

**Multi-user with Cloudflare Access.** Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) in front of your Worker, then set `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` as secrets. Dodo validates the Access JWT on every request and identifies users by email. Add users to the allowlist from the admin panel.

```bash
# Enable Access auth:
wrangler secret put CF_ACCESS_AUD             # your Access app audience tag
wrangler secret put CF_ACCESS_TEAM_DOMAIN     # e.g. https://your-team.cloudflareaccess.com
```

When Access secrets are set, Dodo enforces JWT validation. When they're absent, it runs in single-user mode.

## Architecture

```
Worker (Hono router + optional CF Access auth)
├── SharedIndex DO (global singleton)
│   └── users, host allowlist, models cache, session shares/permissions
├── UserControl DO (one per user)
│   └── config, sessions, memory, tasks, encrypted secrets, MCP configs
├── CodingAgent DO (one per session, extends @cloudflare/think)
│   ├── Think: messages, config, fibers
│   ├── Dodo: metadata, prompts, cron jobs
│   ├── Workspace: @cloudflare/shell (SQLite + R2)
│   └── Sandbox: codemode with gated outbound
└── AllowlistOutbound (WorkerEntrypoint, gated fetch)
```

Three Durable Object classes. **SharedIndex** is a global singleton for user management and permissions. **UserControl** (one per user, keyed by email) holds config, sessions, encrypted secrets, and tasks. **CodingAgent** (one per session) extends `Think` for persistent chat, durable fibers, and tool execution.

### Key design decisions

- **One Think session per DO.** `ensureSingleThinkSession()` enforces this. Think's multi-session capability is not exposed.
- **Fibers replay from scratch.** On recovery, the fiber re-runs from the beginning using `stashFiber()` checkpoints to skip completed work.
- **Git token hierarchy.** Per-user encrypted secrets are tried first, then env vars (`GITHUB_TOKEN`, `GITLAB_TOKEN`) as fallback.
- **Suppressed WebSocket chat.** Think's `cf_agent_chat_*` handlers are intercepted and dropped to prevent a parallel chat path.
- **Streaming UI.** Raw text deltas appear immediately; markdown rendering upgrades a few times per second to keep long responses responsive.

## Development

```bash
npm install
npm run dev          # local dev server (wrangler.dev.jsonc)
npm test             # vitest via @cloudflare/vitest-pool-workers
npm run typecheck    # tsc --noEmit
npm run deploy       # build + deploy to Cloudflare
```

## Contributing

Contributions welcome. Open an issue first for anything non-trivial so we can discuss the approach.

- Run `npm test` and `npm run typecheck` before submitting
- Keep commits atomic with clear messages
- All `@cloudflare/think` imports must go through `src/think-adapter.ts`

## License

[MIT](LICENSE)
