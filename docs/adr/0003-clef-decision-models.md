# ADR 0003: Clef decision models for cheap checks

Status: accepted (2026-10)

## Context

Clef (`@cf/cloudflare/clef`, `clef-omni`, `clef-flash`) are Cloudflare's
decision models on Workers AI
([blog](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)). They
don't write text. They take a state (text, JSON, images) and a schema of typed
questions (yes/no, choice, score) and return a calibrated probability for
every answer, in ~150-350 ms. Clef-flash costs $0.038 per M input tokens.
They speak the same API as `typesafe/jev`, plus a required `model` field.

Before this, Dodo had three gaps:

- A model without vision got `[Image uploaded: x — this model cannot process images]`, and nothing else.
- On a model without vision, every image message became a Replicate edit, even "what colour is this?". So did every message after a generated image, even "thanks!".
- `browser_markdown` used `typesafe/jev` for page checks and URL triage.

## Decision

| Use | Model | Why |
|---|---|---|
| `image_check` tool: yes/no, choice, score questions about this session's attachments, screenshots, or workspace images | clef-flash | Cheapest. A 64 px check is ~350 tokens. |
| Edit vs ask routing for image messages on text-only models | clef-flash, text only (~190 tokens) | Edit when P(edit) ≥ 0.6. Clef errors fall back to ask, because a text answer is a safer miss than an unwanted edit. |
| `browser_markdown` "does this page answer the query" | clef-flash | Pages are capped at 18k chars, which fits its 24k context. |
| `browser_markdown` URL triage | clef | Retrieval-style pick, where flash trails (BRIGHT 39 vs 46). The state is tiny, so the price gap doesn't matter. |

- A model without vision now has uploaded images stored like any attachment (shown in the chat). It is told the URL and how to call `image_check`.
- Vision models skip the routing check and still get `image_check`, which keeps screenshot checks out of their context.
- `image_check` only resolves URLs present in this session's `message_attachments`, or workspace files.

## Not done

- clef-omni (audio, video): nothing in Dodo takes audio or video yet.
- Clef as a cheap "is the goal met?" judge for the goal loop. That is worth trying next, but it needs eval data first.
