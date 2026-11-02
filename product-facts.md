# Integration facts

Verified 2026-10-30 against primary documentation:
- Notion: GET /v1/blocks/{block_id}/children supports pagination and returns direct children. https://developers.notion.com/reference/get-block-children
- Notion: POST /v1/pages creates a child page under a page parent. Pinned version: 2025-09-03. https://github.com/makenotion/notion-mcp-server/blob/main/scripts/notion-openapi.json
- Anthropic: POST /v1/messages; model must be supplied by the user through server configuration. https://platform.claude.com/docs/en/api/messages

## agent-wechat integration (verified 2026-11-02)

- Gewechat was removed: upstream is unmaintained and GeWe no longer accepted new registrations when checked on 2026-11-02.
- https://github.com/thisnick/agent-wechat (MIT) is a third-party client, not a Tencent API. It logs in as a real WeChat account; account risk is not quantified anywhere we could find, so use a secondary account.
- Routes, `Idempotency-Key`, event stream and `mentions` shape come from its `docs/src/content/docs/use/api.mdx`, `use/groups.mdx` and `packages/shared/src/native.generated.ts`.

## Weave v0.2 scope

- Two separately stored local personas with independently scoped ParticipantAgent snapshots. Local consent, proposals, counterproposals and mutual confirmation protocol; not an implementation of Google A2A or a connected third-party agent network.
- One-time reminders execute only while the Node server is running; local calendar plus ICS export, no external calendar API claimed.
- Notion pages configured separately; no fallback to another person's page. The local demo has no WeChat connection.
- Browser runtime discovery returned no available browser. Local QA subsequently passed with standalone headless Chromium against an isolated server/data directory: desktop 1440×1000 and mobile 390×844, persona loading/failure recovery, habit planning, mutual confirmation, calendar download and reminder creation/cancellation. No page errors or mobile horizontal overflow were observed; external integrations remain mock-tested only.

## Weave v1 product implementation (2026-10-30)

- `hosted/` adds Sites-managed authenticated identities, D1 persistence, explicit single-use friend invitations, account-scoped settings/records, UTC stored availability with personal display timezones, real-model negotiation with server-validated constraints, mutual confirmation, cancellation, calendar/data exports and optional owner-scoped Notion memory/sync.
- DeepSeek uses Anthropic Messages at `https://api.deepseek.com/anthropic/v1/messages`; current documented models are `deepseek-flash` and `deepseek-v4-pro`. Source: https://api-docs.deepseek.com/en/
- Node `agent-service/` implements Claude Agent SDK with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, per-request isolated temporary/config directories and no filesystem/shell tools. Hosting that subprocess service is separate from the Cloudflare Worker; until configured, the Worker uses the explicit Anthropic HTTP adapter. SDK import/configuration tests passed; real paid inference requires a user-supplied key.
- D1 atomic batch + strict revision checks protect collaboration writes; separate-user non-collaboration writes may merge. Tests cover the disjoint-document double-booking race.
- 45 automated tests pass. Standalone Chromium passed real local Vinext/Worker/D1 sign-in simulation, settings/availability persistence, invitation creation, feedback reload, mobile reminders and ICS download. Two isolated browser sessions also completed invitation acceptance, model proposals/counterproposals, mutual confirmation and cancellation using mocked DeepSeek responses and real product API/SQLite transactions.
- Worker declares a minute Cron and implements durable reminder processing. The built Worker scheduled handler delivered a closed-browser test reminder into actual local D1, verified by direct SQLite readback. The local static-assets proxy cannot forward scheduled test events; validation used the same Worker without that proxy. Production scheduler activation must still be confirmed by the hosting platform. Account notifications are not system push or WeChat delivery.
