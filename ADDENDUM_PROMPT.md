# ADDENDUM PROMPT — Dashboard, Connectors, Self-Managing Agents/Skills, Self-Updating Components, Browser Research

This extends the existing "Orchestra" repo (see `BUILD_PROMPT.md`). Apply all of that prompt's **working rules (§0), security model (§8), and verification discipline (§13)** to everything below. If the base phases (1–10) are not finished yet, finish them first, then do Phases 11–17 in order. Do not ask questions; record decisions in `docs/DECISIONS.md`.

New requirements in one sentence: a **local web dashboard** that shows everything the system is doing and knows, a **connector hub** (Gmail and others), **100+ agents and hundreds of skills** that can be **created, evaluated, and pruned** by a lifecycle manager, **self-updating components** (never the AI model weights), and **modern web research** using browser-use.

## 0. Hard principles (these override convenience)

1. **Humans stay in control of anything with side effects.** The lifecycle manager may *propose* anything; it may *auto-apply* only low-risk, read-only, test-passing changes, and only if the user enabled that mode.
2. **Nothing updates itself silently if it widens permissions.** Updates that add permissions, tools, scopes, or network access need approval.
3. **The model is never self-modified.** Only components (daemon, extension, skills, tool catalog, MCP servers, CLI tools) update. A fine-tuned router changes only through the explicit retrain flow.
4. **Everything is versioned and reversible** (Git-backed), with soft delete and rollback.
5. **Email, web pages, and any connector data are untrusted input** (taint rules in §8.4 of the base prompt apply).
6. **Local-first and private.** The dashboard binds to `127.0.0.1` only, with an auth token, and can be turned off.

## Phase 11 — Dashboard (web app)

### 11.1 Stack and serving
- New package `packages/dashboard`: Vite + React + TypeScript + Tailwind, `@tanstack/react-query`, `@tanstack/react-virtual` (virtualized lists, since there will be hundreds of rows), `reactflow` for graphs, `recharts` for charts.
- Served by the daemon at `http://127.0.0.1:<port>/` (static build embedded in the daemon package) and also loadable inside a VS Code webview (command `Orchestra: Open Dashboard`). One codebase, two hosts.
- Realtime via WebSocket/SSE from the daemon event bus. REST/JSON‑RPC for queries. All endpoints need the local auth token (cookie set after a one‑time token handoff), CSRF protection, strict CSP, no external requests from the page (bundle fonts/icons locally), and `Host` header validation (anti DNS‑rebinding).
- Dark/light theme, keyboard shortcuts (`/` search, `g a` agents, `g s` skills, etc.), responsive down to a laptop screen, accessible (labels, focus order, contrast).

### 11.2 Pages (all required, all backed by real data)
1. **Overview:** live runs, pending approvals, connector health, router backend, token/cost today, error rate, update available badge, lifecycle proposals count, and a 24‑hour activity chart.
2. **Runs:** list with filters (agent, status, time, tool, connector, tainted/untainted). Each run opens the **Run Inspector** (below).
3. **Run Inspector (the "see the context" feature):**
   - Timeline of steps: router decision → each LLM call → each tool call and result → delegations (as a collapsible tree).
   - **Context viewer per LLM call:** the exact messages sent, segmented and colored: system prompt, agent prompt, loaded skills (with names), retrieved memories (with source + score), tool results, untrusted blocks (highlighted), user message. Show **token counts per segment** and a "what changed since last step" diff.
   - Router panel: candidates, scores, chosen agent/skills/tools, confidence, which backend answered, fallback chain used, and a button "this was wrong → correct it" that writes a training signal.
   - Policy panel: each action's tier, decision (auto/approved/denied), taint flag, approval args.
   - Everything shown is the **redacted** version; a setting controls retention (default 30 days) with "delete this run" and "export JSON".
4. **Agents** (100+): table + card views, search, tags/categories, status (draft/active/deprecated/archived), version, usage stats (runs, success rate, avg steps, avg cost, last used), dependency view (which agents delegate to which, as a graph), enable/disable, edit (system prompt, allowed tools/skills, limits), **diff between versions**, duplicate, delete (soft), rollback.
5. **Skills** (hundreds): same capabilities as Agents, plus: view `SKILL.md`, view scripts, requested permissions, trust status (bundled/user/forged/imported), tests status, used‑by (which agents), overlap warnings (near‑duplicates).
6. **Connectors:** cards for each connector (§12) with status, scopes granted, last used, which agents may use it, connect/disconnect/test, and a usage log.
7. **Tools & MCP servers:** list, health, latency, error rate, risk badges, enable/disable, add server.
8. **Memory explorer:** search and browse by scope (private/workspace/team), each memory shows **provenance** (which run/agent/source wrote it, when), with edit/delete/pin. A "what does the system know about X" search box.
9. **Tasks / Blackboard:** kanban (todo/doing/done/blocked) with owner agent and parent/child links.
10. **Approvals:** pending queue with full details; approve/deny/"allow for session"; history.
11. **Router analytics:** accuracy via user corrections, confusion between agents, most‑missed tools, latency, fallback rate, catalog size, "needs retrain?" indicator (catalog hash changed since the last train), and a button that exports training data.
12. **Lifecycle inbox (§13):** proposals to create/modify/merge/deprecate/delete skills and agents, with evidence and diffs; approve/reject/snooze.
13. **Updates (§14):** components, installed vs available versions, changelog, signature status, update/rollback buttons, policy per component.
14. **Audit log:** searchable, exportable, append‑only view.
15. **Settings:** providers, router backend, permission tiers, redaction, retention, autonomy mode, update policy, dashboard token rotation.

### 11.3 Scale requirements (test them)
- Seed **≥ 150 agents, ≥ 400 skills, ≥ 80 tools, ≥ 20,000 runs** with a script `scripts/seed-demo.mjs`; every list page must render first paint < 1 s and stay at 60 fps scrolling (virtualization) with this data.
- Server pagination and indexed SQLite queries; no endpoint returns unbounded rows.

## Phase 12 — Connector hub (Gmail and others)

### 12.1 Framework
- `packages/daemon/src/connectors/`: each connector is a manifest + implementation:
  ```
  { id, name, auth: "oauth2"|"apikey"|"none", scopes: {read[], write[], send[]},
    tools: [...], risk, docsUrl, rateLimits, taint: true }
  ```
- Prefer using an existing **MCP server** for a service when a maintained one exists; otherwise implement directly with the official API client. Either way, the connector appears to agents as namespaced tools (e.g. `gmail.search`, `gmail.read`, `gmail.draft`, `gmail.send`).
- **OAuth 2.0 with PKCE** run by the daemon on a localhost loopback redirect; tokens stored only in the OS keychain (`keytar` or equivalent) or encrypted file with a key from the keychain; automatic refresh; revoke on disconnect (call the provider's revoke endpoint); never log tokens; show granted scopes in the dashboard.
- **Least privilege by default:** connect read‑only first; write and send scopes are requested only when the user enables them, per connector.
- **Per‑agent grants:** an agent can use a connector only if explicitly granted. Router outputs are clamped to granted connectors.
- All connector tools have `risk` classes. Reads of private data → `read`+tainted; sending/posting/deleting → `network` tier with **mandatory approval showing the exact content** (recipient, subject, body). Never auto‑approve sends, even in "allow session" mode.
- Rate limiting, retry with backoff, pagination, size caps, and structured errors the agent can understand. Connection test button.

### 12.2 Connectors to implement (in this order)
1. **Gmail:** `search`, `read_thread`, `list_labels`, `create_draft`, `send` (approval), `label`/`archive` (approval). Uses the Gmail API. Strip HTML to text, remove tracking pixels, cap body size, and wrap content in untrusted blocks. Attachments are not auto‑opened (metadata only unless the user asks, then size/type checks).
2. **Google Calendar** (read, create event with approval).
3. **Google Drive/Docs** (read, search).
4. **GitHub** (via the existing MCP server).
5. **Slack** (read channels the user selects, post with approval).
6. **Notion** and **Outlook/Microsoft 365** (read‑first).
7. Generic **"Add custom MCP server"** and **"Add custom OAuth/REST connector"** wizard in the dashboard.
- Document in `docs/CONNECTORS.md` how a user creates **their own OAuth client** (for example a Google Cloud project with the Gmail API enabled and an OAuth client of type "Desktop app"), what scopes each tool needs, and the limitation that Google treats Gmail read/modify scopes as restricted/sensitive. For a personal setup the app stays in testing mode; read the current Google documentation and describe exactly what happens (for example, refresh‑token lifetime limits in testing mode) rather than guessing. Do not ship embedded client secrets.

### 12.3 Testing connectors
- Build **fake provider servers** (fake OAuth server + fake Gmail API + fake Calendar API) as test fixtures; run the full flow (authorize → token → refresh → revoke → API calls → error/rate‑limit handling) in CI without network.
- A documented **manual real‑account checklist** (not automated) for the user. Real Gmail is SKIP in `verify` with the reason "requires user credentials".
- Security tests: tokens absent from logs/audit/DB dumps; send without approval is impossible; email body with an injection payload is wrapped, tainted, and forces approval on follow‑up actions; revoking removes access immediately; an agent without a grant cannot call the connector even if the router selects it.

## Phase 13 — Lifecycle manager (create / evaluate / prune skills and agents)

### 13.1 Storage and versions
- Agents and skills live as files in a Git repository at `~/.orchestra/library/` (one folder per item: manifest, prompt/SKILL.md, scripts, tests). Every change is a commit with author `orchestra-lifecycle` or the user. `rollback` = revert commit. The dashboard shows history and diffs.
- States: `draft → sandboxed → active → deprecated → archived → deleted`. `deleted` means purged only after a recovery window (default 30 days). Bundled and **pinned** items cannot be auto‑deprecated or auto‑deleted.
- A **dependency graph** (agents → skills/tools/connectors, agents → agents via delegation) is maintained; deleting or deprecating an item with active dependents is blocked or generates cascading proposals.

### 13.2 Skill Forge (creating new skills)
Triggers: (a) the user clicks "create skill from this run", (b) repeated unmatched or low‑confidence routing, (c) repeated tool‑sequence patterns across runs (mined from run logs), (d) explicit request in chat.
Pipeline (each step logged and visible in the dashboard):
1. **Draft** `SKILL.md` + optional scripts using an LLM, from the run transcripts/examples (redacted).
2. **Static validation:** frontmatter schema, size limits, permission declaration vs the tools actually referenced, a secrets scan, and a dangerous‑pattern scan on scripts.
3. **Duplicate check:** embedding similarity against existing skills; if > threshold, propose *modify existing* instead of create.
4. **Generate tests:** 5+ example tasks the skill should handle and 5 it should not; run the router on them and check selection; run the skill in the sandbox with the mock or real LLM against fixtures.
5. **Impact check:** re‑run the router eval to confirm no regression for existing items (tool recall@15 and agent accuracy must not drop by more than a configured margin).
6. **Proposal** lands in the Lifecycle inbox with the diff, the evidence runs, test results, and requested permissions.
7. **Activation:** by user approval, or automatically **only if** mode is `auto-low-risk` **and** the skill is read‑only (no exec/write/network/screen/send), tests pass, and the daily creation cap isn't exceeded. Otherwise it stays in `sandboxed`.

### 13.3 Agent creation/modification
- Same pipeline for agents (prompt, allowed tools/skills, limits). New agents start `sandboxed` with a low `maxSteps` and cannot be granted connectors or exec/screen tiers without approval.
- **Cap and quality gates:** a global maximum count of active agents (default 250) and skills (default 1000), and a minimum distinctiveness score vs existing agents (embedding distance on purpose statements). Prefer **skills over new agents**: the forge must justify in the proposal why a new agent is needed rather than a skill.

### 13.4 Pruning (deleting unneeded things)
- Nightly (and on demand) **Janitor** job computes per‑item metrics: invocations, success rate, user‑correction rate, last used, cost, overlap with other items (embedding similarity), and failing tests.
- Proposal rules (configurable thresholds, defaults documented): unused for N days (default 60); success rate below a floor with enough samples; near‑duplicate of a better‑performing item (propose **merge**); depends on a broken/removed connector or tool; failing tests for M days.
- Never propose removing: pinned items, bundled core items, items used in the last N days, items that are the only provider of a capability, or items with active dependents (unless the proposal includes handling them).
- Actions: **deprecate** (still works, flagged, router de‑prioritizes), **archive** (removed from the router index, kept on disk), **delete** (soft, recoverable for the window). The dashboard shows what would be removed and **why**, with a "keep" button that pins it.
- All Janitor actions are proposals unless the mode is `auto-prune-safe` (deprecate/archive only, never delete, only for unused, non‑pinned, dependency‑free items).

### 13.5 Autonomy modes (setting)
`manual` (no proposals), `suggest` (default: proposals only), `auto-low-risk` (auto‑activate safe read‑only skills; auto‑deprecate unused), `off`. Show the current mode prominently in the dashboard.

### 13.6 Router consistency with 100+ agents
- The router becomes **two‑stage**: (1) pick the agent family/category from a short list (≈ 15–25 categories), (2) pick the agent within the category and the skills/tools by retrieval + model selection. Document the data format changes and update the golden parity tests (TS ↔ Python).
- Catalog changes (new, archived, or deleted items) update the retrieval index immediately. If the fine‑tuned router's catalog hash is stale, the ensemble keeps working through retrieval and the dashboard shows "retrain recommended"; a button launches `router-training` with the exported data. No silent retraining.
- Ship the **seed library**: ≥ 100 agent definitions across categories (coding, review, testing, DevOps, security, data, research, writing, email/calendar assistant, project management, support, finance, legal‑reading, education, design, ops, etc.) and ≥ 150 skills. **Quality over padding**: each agent has a distinct purpose, a concise system prompt, allowed tool tags, and example tasks; each skill has real, usable instructions. Generate from a structured source file where sensible, but review that no two items are near‑identical (a test enforces a similarity ceiling).

### 13.7 Tests
- Janitor simulation on synthetic usage logs: correctly proposes unused/duplicate/failing items, never proposes pinned/bundled/dependent items; "keep" pins; delete is soft and restorable; rollback restores.
- Forge tests with the mock LLM: a good skill passes the pipeline; a skill requesting undeclared permissions is rejected; a near‑duplicate becomes a *modify* proposal; a skill that harms router accuracy is blocked; `auto-low-risk` never auto‑activates anything with write/exec/network/screen/send.
- Cap enforcement; dependency blocking; Git history integrity.

## Phase 14 — Self‑updating components (not the AI model)

### 14.1 What can update
Daemon, CLI, dashboard, extension (via the marketplace as normal; plus a "check compatibility" handshake between extension and daemon versions), bundled skills/agents library, tool/connector catalog, MCP servers the user installed, `agent-desktop`, `agent-browser`, `browser-use` and its Playwright browser. The router **model** is excluded (explicit retrain/replace only).

### 14.2 Update mechanism
- Update **channels**: `stable` (default), `beta`. A **signed manifest** (Ed25519 or minisign/sigstore) lists component versions, hashes, minimum compatible versions, changelog, and the **permission diff** vs the installed version.
- Flow: check on a schedule (default daily, and manually) → download to a temp dir → verify signature + checksum → show the permission diff → apply per policy → install **side‑by‑side** → run a **self‑test** (daemon health, RPC handshake, a smoke tool call, router smoke eval) → switch the active version → keep the previous version for **one‑click rollback**. A failed self‑test auto‑rolls back and reports in the dashboard.
- Per‑component policy: `off`, `notify` (default), `auto-patch` (patch versions only, no permission diff), `auto` (patch+minor, no permission diff). Major versions or any permission/scope/network widening always need approval.
- **Supply‑chain safety:** pin exact versions; do not auto‑adopt releases younger than N days (default 7) for third‑party CLIs; verify GitHub release attestations where the project documents them (for example, `gh attestation verify` for agent-desktop archives); run `npm audit` and `pip-audit` and show results on the Updates page; never execute downloaded code before verification; refuse downgrade attacks (monotonic version check) unless the user explicitly rolls back.
- Third‑party tools are updated **together with the version‑matched guides** they ship (for example, re‑reading `agent-desktop skills get desktop` after an update) and the `desktop-operator` agent's cached guide is invalidated.
- Offline mode: updater does nothing and says so.

### 14.3 Tests
Local fake update server with a signed manifest: valid update applies; tampered manifest/hash rejected; unsigned rejected; permission‑widening update blocked from auto mode; failing self‑test triggers rollback; downgrade blocked; age‑threshold honored; rollback restores the previous version; offline mode behaves.

## Phase 15 — Modern web research with browser-use (plus a tool ladder)

### 15.1 Facts to rely on (verify against the repo README before coding)
- browser-use is an open‑source Python library (`pip install browser-use`, Python ≥ 3.11) that lets an LLM control a Chromium browser; browsers install via Playwright (e.g. `uvx playwright install chromium --with-deps --no-shell`).
- It can run as an **MCP server** (`uvx browser-use --mcp` with an LLM API key in the environment) and can also **consume** MCP servers. Its `main` branch changes frequently, so **pin a stable released version**, not `main`.
- It's an autonomous agent (it has its own LLM loop), unlike `agent-browser` which is a deterministic CLI your own loop drives.

### 15.2 Integration
- Run browser-use as a **Python sidecar process** managed by the daemon (start on demand, health check, restart, timeouts, kill on cancel), or as an MCP server through the existing MCP manager. Choose one, document why.
- Expose tools: `web_search`, `web_fetch`, `web_browse(task, start_url?, allowed_domains[], max_steps, max_cost)`.
- **Escalation ladder** (cheapest first; the `researcher` agent's prompt and the router know it):
  1. `web_search` via a configurable search backend (support at least two: a hosted search API with key, and self‑hosted SearXNG), returns titles/snippets/URLs.
  2. `web_fetch` (HTTP + readability extraction, with size/time caps and robots.txt respect).
  3. `agent-browser` for deterministic interaction (accessibility snapshots, refs).
  4. `browser-use` for open‑ended multi‑step web tasks.
- **Guardrails:** domain allow/deny lists; no logged‑in sessions unless a dedicated, user‑created browser profile is configured (never the user's main profile by default); downloads go to a quarantined folder; no form submission or purchases without approval (policy tier `network`, with an approval that shows the target and data); step and cost budgets; captcha is not bypassed (report and stop); all page text enters context as untrusted/tainted content.
- Citations: the `researcher` agent must return sources (URL + retrieved time) and the dashboard shows them in the run inspector.
- The Python sidecar has its own virtualenv managed by `orchestra doctor --fix`, and uses the same LLM provider config (including local OpenAI‑compatible endpoints).

### 15.3 Tests
- Fake search backend + local static test site: `web_search → web_fetch` flow; domain deny list enforced; size/time caps; robots.txt respected; injection payload on the test page is wrapped, tainted, and does not cause an unapproved action.
- browser-use end‑to‑end against the local test site using a mock OpenAI‑compatible LLM server if feasible; otherwise SKIP with the reason (browser or LLM unavailable). Never mark PASS without running.

## Phase 16 — Data model and API additions

- New SQLite tables/migrations (with a migration runner and tests): `connectors`, `connector_grants`, `library_items` (agents/skills with state, version, pinned, source), `library_history`, `proposals` (kind, target, evidence, diff, status, created_by), `item_metrics`, `llm_calls` (redacted request segments + token counts), `updates`, `settings_history`.
- RPC/REST additions: `library.*` (list/get/diff/rollback/pin/delete/restore), `proposals.*`, `connectors.*`, `updates.*`, `runs.*` (with context segments), `metrics.*`, `dashboard.session`.
- Retention jobs (runs, llm_calls, audit) with configurable windows and a "purge now" action.
- Event stream topics: `run.*`, `approval.*`, `proposal.*`, `connector.*`, `update.*`, `janitor.*`.

## Phase 17 — Verification, docs, and report

Extend `npm run verify` with these additional checks (PASS/FAIL/SKIP with reason, as before):
1. Dashboard: build, typecheck, component tests, and **Playwright end‑to‑end tests** that load every page with the seeded data (≥150 agents, ≥400 skills, ≥20,000 runs), assert render time, open a Run Inspector and verify context segments and token counts, approve/deny an approval, pin/deprecate/restore a skill, and run through the proposal approve/reject flow. Include an accessibility check (axe) with zero critical violations.
2. Dashboard security: unauthenticated requests rejected; bad `Host` header rejected; CSRF protected; CSP present; no outbound requests during page load (assert via the test browser).
3. Connector suite (§12.3) including OAuth against fake servers.
4. Lifecycle suite (§13.7) and router two‑stage eval on the seeded catalog (thresholds: tool recall@15 ≥ 0.90; agent‑family accuracy ≥ 0.90 on the synthetic test set; router retrieval p95 < 50 ms with 150 agents + 400 skills + 80 tools).
5. Updater suite (§14.3).
6. Research suite (§15.3).
7. A **full scenario e2e with the mock LLM**: connect fake Gmail → ask "summarize unread email from this week and draft replies" → router selects the email agent and Gmail tools → read flows are tainted → `create_draft` works → `send` requires approval and shows the exact content → the whole run is visible in the dashboard with its context segments → the Janitor/Forge simulated by a seeded history proposes one new skill and one deprecation → approve → the router index updates.
8. Performance and memory smoke test of the daemon under 50 concurrent mock runs.

Docs to add/update: `docs/DASHBOARD.md`, `docs/CONNECTORS.md`, `docs/LIFECYCLE.md`, `docs/UPDATES.md`, `docs/RESEARCH.md`, `docs/SECURITY.md` (new threat model entries: email injection, malicious skills, update tampering, DNS rebinding on the dashboard), and refresh `docs/VERIFICATION_REPORT.md` with real outputs.

## Definition of Done (additional)
- [ ] Dashboard runs locally, authenticated, with all 15 pages working on the seeded scale data.
- [ ] Run Inspector shows the real, redacted context per LLM call with token counts and router/policy details.
- [ ] Gmail connector works end to end against the fake provider, with least‑privilege scopes, per‑agent grants, approval‑gated send, and a documented manual real‑account checklist.
- [ ] ≥ 100 agents and ≥ 150 skills in the seed library, routed by the two‑stage router within thresholds.
- [ ] Forge and Janitor produce evidence‑backed proposals, respect pins/dependencies/caps/autonomy modes, and every change is versioned, reversible, and soft‑deleted.
- [ ] Updater verifies signatures, shows permission diffs, self‑tests, and rolls back; the AI model is never updated by it.
- [ ] Research ladder works (search → fetch → agent-browser → browser-use) with guardrails, and browser-use tests either pass or are SKIPPED with a legitimate environmental reason.
- [ ] `npm run verify` exits 0 and the report is honest about SKIPs and unverified areas.

Final response format: same as the base prompt (§15), plus a short "How to use the dashboard, connect Gmail, review proposals, and update components" quickstart.
