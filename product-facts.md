# Integration facts

Verified 2026-10-30 against primary documentation:
- Notion: GET /v1/blocks/{block_id}/children supports pagination and returns direct children. https://developers.notion.com/reference/get-block-children
- Notion: POST /v1/pages creates a child page under a page parent. Pinned version: 2025-09-03. https://github.com/makenotion/notion-mcp-server/blob/main/scripts/notion-openapi.json
- Anthropic: POST /v1/messages; model must be supplied by the user through server configuration. https://platform.claude.com/docs/en/api/messages
- GitHub repository inventory read using authenticated gh repo list Janettbella69; no identified Habit Council project.

Muse / cue / dots: ambiguous references, awaiting exact links. No claims about those products are made.

## Gewechat integration (verified 2026-10-30)

- Repository is a technical archive, not a complete deployable service: https://github.com/Devo919/Gewechat
- Historical request routes and parameters checked against the repository Java client via GitHub API: `api/base/MessageApi.java`, `api/base/LoginApi.java`, `util/OkhttpUtil.java`.
- Adapter uses `/v2/api`, `X-GEWE-TOKEN`, `/message/postText` and `ret=200`. Does not copy trust-all TLS code.
- Callback outer casing observed in historical ecosystem integrations; real deployment compatibility remains unverified.
- Real Gewechat and Notion credentials absent at implementation time; tests use mocked services.

## Weave v0.2 scope

- Two separately stored local personas with independently scoped ParticipantAgent snapshots. Local consent, proposals, counterproposals and mutual confirmation protocol; not an implementation of Google A2A or a connected third-party agent network.
- One-time reminders execute only while the Node server is running; local calendar plus ICS export, no external calendar API claimed.
- Gewechat maps two explicitly configured wxids to their own personal state. Notion pages configured separately; no fallback to another person's page.
- Browser runtime discovery returned no available browser. Real-browser visual QA remains unverified.
