# MASTER BUILD PROMPT — "Orchestra": Agent Orchestration System with Fine-Tuned Router, Screen Reading, and VS Code Extension

You are an autonomous senior engineer. Build the entire system below, end to end, in one working repository. Do not stop to ask questions. Make reasonable decisions, record them in `docs/DECISIONS.md`, and keep going until every item in the **Definition of Done** passes with real command output as evidence.

## 0. Non‑negotiable working rules

1. **No placeholders.** No `TODO`, `pass`, `throw new Error("not implemented")`, stub functions, or fake data presented as real. If something truly cannot be built, say so in `docs/KNOWN_LIMITS.md` and build the closest working alternative.
2. **Run everything you write.** After each phase, run its tests and the phase gate. Fix failures before moving on. Never claim something works unless you ran it and saw it pass.
3. **Honest reporting.** The final report must separate: (a) verified by a command you ran, (b) skipped and why (e.g. no GPU, no API key, no display), (c) not done. Never mark a skipped check as passed.
4. **Do not trust this prompt for exact CLI syntax of third‑party tools.** Read each tool's `--help`, README, and its built‑in guides (see §6) and follow those where they differ.
5. **Work offline‑capable.** Everything must be testable with a built‑in **mock LLM provider** and no API keys. Real providers are optional extras.
6. **Commit after every phase** with a clear message. Keep the repo runnable at every commit.
7. **Security is a feature, not a phase.** The policy engine (§8) must exist before any dangerous tool (shell, file write, screen control) is wired up.

## 1. Product summary

A system like Claude Code, as a VS Code extension plus a local daemon, in which:

- A user types a task in a VS Code chat panel.
- A **Router** (small, fine‑tunable model) decides **which agent** handles it and **which skills and tools** that agent gets (top‑k out of hundreds).
- The chosen **agent** runs a tool‑calling loop with those tools/skills.
- Agents can **delegate** to other agents and **share information** through shared memory, a task board, and a message bus (local, plus an optional team hub server).
- Agents can **read and operate the screen** using Vercel Labs `agent-desktop` (native apps, via OS accessibility tree) and `agent-browser` (web pages).
- A **policy engine** gates every action by permission tier and asks the user for approval in VS Code.
- A **training pipeline** produces and evaluates the fine‑tuned router, and the runtime can load it.

## 2. Tech stack (use these unless blocked)

| Area | Choice |
|---|---|
| Monorepo | npm workspaces (or pnpm), TypeScript strict, Node ≥ 20 |
| Daemon | TypeScript/Node, Fastify (hub), `better-sqlite3`, `zod`, `pino` |
| Tool protocol | Official `@modelcontextprotocol/sdk` (client) |
| Extension | VS Code API, TypeScript, esbuild bundling, `@vscode/vsce` |
| Tests | `vitest`, `@vscode/test-electron`, Python `pytest` |
| Router training | Python ≥ 3.10, `transformers`, `peft`, `trl`, `datasets`, `scikit-learn` |
| Retrieval | BM25 (pure TS, always available) + optional embeddings (`@huggingface/transformers` with `bge-small-en-v1.5`, or an OpenAI‑compatible embeddings endpoint) |
| Local model serving | Any OpenAI‑compatible endpoint (Ollama, llama.cpp server, vLLM) |

## 3. Repository layout (create exactly this)

```
orchestra/
├─ package.json                 # workspaces + root scripts
├─ tsconfig.base.json
├─ README.md
├─ docs/
│  ├─ ARCHITECTURE.md  DECISIONS.md  KNOWN_LIMITS.md
│  ├─ SECURITY.md      ROUTER.md     SKILLS.md   VERIFICATION_REPORT.md
├─ packages/
│  ├─ shared/                   # types, zod schemas, JSON-RPC protocol, constants
│  ├─ daemon/                   # the engine (runs standalone: `orchestra-daemon`)
│  │  └─ src/
│  │     ├─ main.ts  rpc/  config/  logging/
│  │     ├─ llm/        (provider interface, anthropic, openai-compat, mock)
│  │     ├─ router/     (bm25, embeddings, llm-router, finetuned-router, ensemble, logger)
│  │     ├─ agents/     (runtime loop, supervisor, delegation, built-in agent definitions)
│  │     ├─ tools/      (registry, builtin/, mcp/, screen/, sandbox/)
│  │     ├─ skills/     (SKILL.md loader, index, progressive disclosure)
│  │     ├─ policy/     (tiers, approvals, injection guard, redaction, audit)
│  │     ├─ memory/     (sqlite store, FTS5 search, ACL, blackboard, bus)
│  │     └─ hub-client/ (talks to team hub)
│  ├─ hub/                      # optional team server (Fastify + WebSocket + SQLite)
│  ├─ cli/                      # `orchestra` CLI: chat, route, tools, skills, doctor, eval
│  └─ extension/                # VS Code extension
├─ router-training/             # Python pipeline (data gen, train, eval, export)
│  ├─ gen_data.py  train_lora.py  eval_router.py  export.py  requirements.txt
│  └─ data/ (generated)         # train.jsonl  val.jsonl  test.jsonl  catalog.json
├─ skills/                      # bundled example skills (SKILL.md folders)
├─ tools-manifest/              # bundled tool catalog JSON (descriptions, risk, permissions)
├─ e2e/                         # end-to-end scripts
└─ scripts/verify.mjs           # one-command verification (see §13)
```

## 4. Phase plan (do in order; each has a gate)

### Phase 1 — Foundation + LLM layer
- Monorepo, shared types, strict TS, lint, `npm run build/test/typecheck` at root.
- `LLMProvider` interface: `chat({messages, tools?, json_schema?, temperature, max_tokens, signal}) → {text, toolCalls[], usage}`. Streaming supported.
- Providers: **mock** (deterministic, scriptable for tests, can emit tool calls from a script), **anthropic** (default model from env `ORCHESTRA_MODEL`, default `claude-sonnet-5-5`), **openai-compat** (base URL + model from config, works with Ollama).
- Config: `~/.orchestra/config.json` + env overrides, validated by zod. Secrets only from env or OS keychain/VS Code SecretStorage; never written to logs.
- **Gate:** unit tests for all providers (mock fully; real ones with recorded fixtures or skipped‑with‑reason if no key).

### Phase 2 — Tool & skill registry
- `ToolSpec`: `{id, name, description, inputSchema, risk: "read"|"write"|"exec"|"screen"|"network", permissions[], tags[], source: "builtin"|"mcp"|"skill", embedding?}`.
- Built‑in tools (all path‑jailed to the workspace root; reject `..` and symlink escapes): `fs_read`, `fs_write`, `fs_edit` (string replace), `fs_list`, `fs_search` (ripgrep or JS fallback), `git_status`, `git_diff`, `git_commit`, `shell_exec` (sandboxed, §8), `http_fetch` (allow‑list + size/timeouts), `memory_read`, `memory_write`, `task_create`, `task_update`, `delegate`, `ask_user`.
- **MCP client manager**: load servers from config (stdio and HTTP), list tools, namespace them `mcp.<server>.<tool>`, reconnect with backoff, per‑call timeouts, health status, and import their tool descriptions into the registry.
- **Skills**: scan `skills/` (bundled), `~/.orchestra/skills`, and `<workspace>/.orchestra/skills`. Each skill is a folder with `SKILL.md` (YAML frontmatter `name`, `description`, optional `permissions`, `tags`) plus optional `scripts/` and `resources/`. Use **progressive disclosure**: only name+description are indexed and shown to the router; the full body is loaded into the agent's context only when the skill is selected. Validate frontmatter; refuse skills requesting undeclared permissions.
- Ship ≥ 12 bundled skills (e.g. `code-review`, `write-tests`, `refactor`, `debug-failing-test`, `git-workflow`, `web-research`, `desktop-automation`, `browser-automation`, `doc-writer`, `data-analysis`, `security-audit`, `release-notes`) with real, useful instructions (not lorem ipsum).
- Ship a **tool catalog of ≥ 60 entries** in `tools-manifest/` (builtin, common MCP servers such as GitHub/filesystem/postgres/slack, screen tools) so the router has a realistic set to choose from.
- **Gate:** registry tests; path‑jail escape tests; MCP test using a tiny in‑repo MCP server fixture; skill loader tests including malformed skills.

### Phase 3 — Policy engine & sandbox (before dangerous tools run)
See §8. Implement fully, with tests, then wire `shell_exec`, `fs_write`, and screen tools through it.
- **Gate:** every security test in §8 passes.

### Phase 4 — Agent runtime
- Agent definition: `{id, name, systemPrompt, defaultSkills[], allowedTools[]|tags, maxSteps, model}`. Ship built‑ins: `coder`, `reviewer`, `researcher`, `desktop-operator`, `browser-operator`, `planner`, `general`.
- Runtime loop: build context → LLM → parse tool calls → **policy check** → execute → append result → repeat until final answer or `maxSteps`/budget/abort. Handle tool errors by returning them to the model (not crashing). Truncate big outputs with a marker and an `output_id` the model can page through.
- **Delegation:** `delegate({agent, task, context})` spawns a sub‑run with its own tool set (selected by the router), depth limit (default 3), cycle detection, shared budget, and results returned as a structured summary.
- Supervisor mode: the `planner` agent can decompose a task into subtasks stored on the blackboard and dispatch to agents, then merge results.
- Cancellation (AbortSignal) works everywhere, including child processes.
- **Gate:** integration tests with the mock LLM: single‑agent tool loop, tool error recovery, delegation (depth + cycle limit), cancellation, budget exhaustion.

### Phase 5 — Router
See §7. Implement runtime router first (BM25 → embeddings → LLM router → ensemble), then the training pipeline.
- **Gate:** router eval ≥ thresholds in §7.5; fine‑tune smoke test runs.

### Phase 6 — Shared memory, blackboard, bus, hub
See §9.
- **Gate:** memory ACL tests; two daemons syncing through a local hub in an e2e test.

### Phase 7 — Screen reading (agent-desktop + agent-browser)
See §6.
- **Gate:** tests with a fake CLI shim (always run) and, where possible, real `agent-browser` against a local test page.

### Phase 8 — Daemon RPC + CLI
- JSON‑RPC 2.0 over stdio and WebSocket (localhost only, random auth token). Methods: `chat.send`, `chat.cancel`, `route.preview`, `tools.list`, `skills.list`, `approvals.respond`, `memory.query`, `tasks.list`, `config.get/set`, `status`, `doctor`. Server → client notifications: `chat.delta`, `chat.toolCall`, `chat.toolResult`, `approval.request`, `route.decision`, `task.update`.
- CLI `orchestra`: `chat`, `route "<task>"` (prints the decision JSON), `tools`, `skills`, `doctor`, `eval`, `serve`.
- `orchestra doctor` checks: Node version, config validity, provider reachability, `agent-desktop`/`agent-browser` installed (version), OS accessibility permission hints, Docker availability, MCP server health, writable data dir.
- **Gate:** protocol tests; CLI smoke tests.

### Phase 9 — VS Code extension
See §10.
- **Gate:** extension builds, `.vsix` packages, and the `@vscode/test-electron` suite passes.

### Phase 10 — Docs, verification, report
- Write all docs. Run `npm run verify` (§13). Fill `docs/VERIFICATION_REPORT.md` with real outputs. Fix everything that fails.

## 5. Agent communication model (summary)

- **Delegation** (synchronous parent→child) via the `delegate` tool.
- **Blackboard** (shared task table: `id, title, status, owner_agent, inputs, outputs, parent_id, created_at`).
- **Bus** (publish/subscribe topics: `task.*`, `agent.*`, `memory.*`), in‑process locally, NATS‑free: the hub provides WebSocket pub/sub for teams.
- **Memory** (long‑term facts) with scopes: `private` (user), `workspace`, `team`.

## 6. Screen reading with Vercel Labs tools

Use these two open‑source CLIs (Apache‑2.0, from `vercel-labs`). They contain **no model**; they are tools your agent loop drives.

### 6.1 agent-desktop (native desktop apps; macOS, Windows, Linux)
- Install: `npm install -g agent-desktop` (or native binary from GitHub Releases). Build from source requires Rust.
- It reads the OS accessibility tree (macOS AX, Windows UI Automation, Linux AT‑SPI) and returns **one JSON envelope per command** (`ok`, `command`, `data`, …).
- Core loop: **observe → act on a ref → observe again to verify**.
  ```
  agent-desktop list-apps
  agent-desktop snapshot --app "<App>" -i        # interactive elements, each with a ref
  agent-desktop click '<ref>'                    # ref comes from the latest snapshot
  agent-desktop snapshot --app "<App>" -i
  ```
- Ref format is `@<snapshot_id>:eN` (e.g. `@s8f3k2p9:e8`). A bare `@e8` is rejected. On Windows PowerShell **quote refs** (`'@s8f3k2p9:e8'`) or the shell eats them.
- Errors to handle explicitly: `STALE_REF`, `AMBIGUOUS_TARGET`, `INVALID_ARGS`. On stale/ambiguous refs, **take a fresh snapshot and retry** (bounded retries). Check the snapshot's `complete` field; if false, the observation was truncated, so narrow with `--root` / `--skeleton`.
- Commands are headless by default; `--headed` (real input) needs explicit user approval via the policy engine. `key-down/key-up/mouse-down/mouse-up` refuse to run; do not expose them.
- It has an **MCP mode**: `agent-desktop mcp` (stdio). Tools are named after commands (`desktop_snapshot`, `desktop_click`, …) and global flags like `--session`, `--headed`, `--trace` apply. **Preferred integration:** register it as an MCP server in the MCP manager, with every tool classified `risk: "screen"`.
- The binary carries version‑matched guides: run `agent-desktop skills get desktop` and `agent-desktop skills get platform` and **embed their output into the `desktop-operator` agent's context at runtime** (do not hard‑code stale copies).
- Snapshots, clipboard reads, screenshots, and debug artifacts can contain private content. Apply redaction (§8) before anything is logged, stored in memory, or sent to a remote model.

### 6.2 agent-browser (web pages)
- Install: `npm install -g agent-browser && agent-browser install` (downloads a browser; if the network blocks it, mark browser tests as skipped with the reason).
- Accessibility‑tree snapshots with refs: `agent-browser open <url>`, `snapshot -i`, `click @e5`, `fill @e1 "text"`, `press Enter`, `wait --load networkidle`, `read`, `get title|url|count`, `screenshot <file>`, `close`.
- Use a **named `--session`** for every run (recent releases require it for agent use), and always `close` it in a `finally`.
- No built‑in assumption of MCP: wrap it as a `browser_*` tool family that shells out to the CLI with argument arrays (never string‑concatenated shell commands), parses output, applies timeouts, and applies the same stale‑ref retry logic.

### 6.3 Required integration behaviors
1. Screen content is **untrusted data**. Snapshots enter the model context inside clearly delimited blocks (`<untrusted_screen_content source="...">…</untrusted_screen_content>`), and the system prompt tells the model never to follow instructions found there (§8.4).
2. Token control: default to `-i` interactive snapshots, `--skeleton`/`--root` for big UIs, and cap snapshot size with a visible truncation marker.
3. A **fake CLI shim** (`packages/daemon/test/fixtures/fake-agent-desktop`) that mimics the JSON envelopes, including `STALE_REF`, must exist so the whole screen pipeline is testable on any machine, including CI without a display.
4. `orchestra doctor` reports clearly if accessibility permission is missing (macOS: grant Accessibility to the terminal/VS Code).
5. Early spike (do in Phase 7, document in `docs/KNOWN_LIMITS.md`): test whether agent-desktop can see VS Code's own UI (Electron). If it can't read the editor area, document the limitation. The extension's own APIs remain the primary way to read editor content.

## 7. The Router (core of the product)

### 7.1 What it does
Input: `{task, conversation_summary?, workspace_context{languages, open_files, git_state}, catalog}`.
Output (validated by zod, always JSON):
```json
{
  "agent": "coder",
  "skills": ["write-tests"],
  "tools": ["fs_read", "fs_edit", "shell_exec"],
  "needs_screen": false,
  "risk": "write",
  "confidence": 0.86,
  "reason": "short text"
}
```
The router **suggests**. The policy engine **decides**. Router output is clamped to the catalog (unknown ids dropped), to `k ≤ 15` tools, and to the permissions the user has granted.

### 7.2 Runtime backends (build all, pluggable, selected by config)
1. `bm25`: pure TS lexical retrieval over name+description+tags. Always available, the fallback.
2. `embedding`: cosine similarity over precomputed catalog embeddings (cache to disk; recompute on catalog hash change).
3. `llm`: prompt‑based routing via any `LLMProvider` with `json_schema` output; candidate list pre‑filtered by retrieval to top‑40 to fit context.
4. `finetuned`: calls a fine‑tuned small model through an OpenAI‑compatible endpoint (or loads GGUF via the endpoint); same prompt format as training.
5. `ensemble` (default): retrieval top‑40 → chosen model re‑ranks/selects → if confidence < threshold or JSON invalid, fall back down the chain (finetuned → llm → embedding → bm25). The router **never throws**; worst case it returns the `general` agent with the top‑5 BM25 tools.
- Log every decision to SQLite `routing_log` (task hash, candidates, decision, latency, later outcome: success/failure/user‑override). Add `orchestra route --explain`.
- Capture **user override** (the user edits tools/agent in the UI) as a training signal.

### 7.3 Training data pipeline (`router-training/`)
- `gen_data.py` builds a dataset from `catalog.json` (export of the real tool/skill/agent catalog): ≥ **3,000 examples** by default, configurable.
  - Templated + paraphrased task generation (use the mock/real LLM if available; otherwise rule‑based templates with synonyms and noise: typos, short/long phrasing, multi‑step tasks, ambiguous tasks).
  - Include **hard negatives** (similar tools that are wrong), multi‑tool tasks, screen tasks, and "general chat" tasks that need no tools.
  - Each record: `{task, workspace_context, candidates[], label{agent,skills,tools,needs_screen}}`.
  - Split by **catalog item/template families** to avoid leakage: `train 80% / val 10% / test 10%`, plus a **held‑out set of unseen tools** to measure generalization.
- `train_lora.py`: LoRA/QLoRA SFT with `trl`'s `SFTTrainer` on a small base (default `Qwen/Qwen2.5-0.5B-Instruct`; allow `--base` override for 1.5B/3B). Prompt format = system + candidates list + task → strict JSON. Flags: `--max-steps`, `--cpu` (for smoke tests), `--bf16`, `--out`. Saves adapter + merged model + `router_config.json` (prompt version, catalog hash).
- `eval_router.py`: computes on the test set for **any** backend (bm25, embedding, llm, finetuned): agent accuracy, tool precision/recall/F1, exact‑set match, JSON validity rate, p50/p95 latency, unseen‑tool recall. Writes `router-training/reports/<backend>.json` and a markdown comparison table.
- `export.py`: merges the adapter, optionally converts to GGUF (if `llama.cpp` available), and writes an Ollama `Modelfile` + instructions.
- **Smoke fine‑tune requirement:** a `--smoke` mode that trains a tiny model for ~20 steps on CPU in minutes and proves the full pipeline (data → train → export → serve → eval) works end to end. A full‑quality run needs a GPU; the README must say how to run it (including on rented GPUs) and the expected command.

### 7.4 Prompt format (training and inference must be byte‑identical)
Put one function `buildRouterPrompt()` in `shared` (TS) and mirror it in Python, with a **golden test** that compares outputs for 50 fixtures so they can never drift.

### 7.5 Acceptance thresholds (on the generated test set, with the shipped catalog)
- BM25 baseline: report numbers (no threshold; it's the baseline).
- Ensemble (retrieval + mock/real model): tool recall@15 ≥ **0.90**.
- Fine‑tuned (full GPU run, if hardware exists): agent accuracy ≥ **0.90**, tool F1 ≥ **0.80**, JSON validity ≥ **0.99**. If no GPU is available, report the smoke result honestly and **do not claim** these numbers.
- Router latency p95 (retrieval only) < 50 ms for a 500‑tool catalog.

## 8. Security (policy engine) — implement fully

### 8.1 Permission tiers
`read` → `write` → `exec` → `screen` → `network`. Config defines per‑tier mode: `deny | ask | allow`, with per‑workspace overrides and per‑tool overrides. Defaults: read=allow, write=ask, exec=ask, screen=ask, network=ask. Support "allow once / allow for this session / always for this workspace".

### 8.2 Approvals
`approval.request` goes to the extension with a human‑readable summary (tool, arguments, diff for writes, command string for exec, target app/ref for screen). No response within the timeout = **deny**. Approvals are bound to the exact arguments hash.

### 8.3 Sandbox for `shell_exec`
- Preferred: Docker container (no network by default, read‑only root, workspace mounted at a fixed path, CPU/mem/time limits, non‑root user). Fallback when Docker is missing: restricted subprocess in the workspace with env scrubbing, timeout, output cap, and a **clear warning that it is not isolated**, so default to `deny` for exec in that mode unless the user explicitly opts in.
- Use argument arrays, never `shell: true` with interpolated user/model strings. Block obviously destructive patterns as a safety net (not as the only defense).

### 8.4 Prompt‑injection defense
- All tool results from untrusted sources (web, screen, files fetched, MCP third‑party) are wrapped in delimited untrusted blocks; the system prompt states the rule.
- **Taint tracking:** if untrusted content was in context during the last model turn, any `exec`/`write`/`network`/`screen` action is **forced to `ask`** (never auto‑allowed), and the approval dialog says it follows untrusted content.
- Heuristic scanner flags common injection phrases in untrusted content and shows a warning badge in the UI (advisory only).
- Never let tool output change the permission tier or approvals.

### 8.5 Secrets and redaction
- Secrets only via env/keychain/SecretStorage. Redactor masks API keys, tokens, private keys, password fields in screen snapshots (role `textbox` with password type), emails/phones optionally, applied to logs, memory writes, hub sync, and prompts sent to remote models (configurable). Block‑list of apps for screen tools (e.g. password managers, banking) configurable.

### 8.6 Audit
Append‑only JSONL audit log of every tool call: time, agent, tool, redacted args, decision (auto/approved/denied), result status. `orchestra audit --tail`. Extension has "Show audit log" command.

### 8.7 Skill/MCP trust
- Skills and MCP servers from outside the bundled set start as **untrusted**: shown with their requested permissions, require explicit enable. Hash‑pin skill folders; warn when content changes.
- Script files inside skills run only through the sandbox.

### 8.8 Required security tests (all must pass)
Path traversal and symlink escape blocked; shell injection via args blocked; approval timeout denies; approval bound to args (changing args invalidates); taint forces `ask`; secrets never appear in audit/log fixtures; redaction of password fields; hub rejects bad tokens and cross‑scope reads; destructive command safety net; oversize output cap; MCP tool name collision handling.

## 9. Shared memory, blackboard, bus, hub

- Local store: SQLite (WAL) with tables `memories` (id, scope, owner, text, tags, embedding?, created_at, acl), `tasks`, `messages`, `routing_log`, `audit` (or file). FTS5 for search; optional embeddings; retrieval API `memory_read(query, scope?, k)`.
- **ACL:** every item has `scope` and `owner`; reads and writes enforce it; team scope requires hub auth. Memory writes go through the redactor.
- **Hub** (`packages/hub`): Fastify + WebSocket, token auth (per user, per team), endpoints for memory sync (append‑log with vector clocks or last‑write‑wins with timestamps; document the choice), task board, pub/sub topics, presence, rate limits, request size limits, structured logs. Provide `docker-compose.yml` for the hub.
- `hub-client` in the daemon: offline‑first queue, reconnect, conflict handling.
- Two agents on two daemons must be able to: post a task to the shared board, have the other pick it up, write a result, and the first reads it. Cover with an e2e test.

## 10. VS Code extension (`packages/extension`)

- Name `orchestra`, publisher placeholder configurable in `package.json`. Activation: `onStartupFinished` and on its commands/views. Bundle with esbuild into `dist/extension.js`.
- **Daemon lifecycle:** spawn the bundled daemon (or user‑configured path) as a child process over stdio JSON‑RPC; health checks, auto‑restart with backoff, clean shutdown, output channel "Orchestra". If the daemon is unreachable, show a status‑bar error with a "Run doctor" action.
- **UI:**
  - Activity‑bar view with a **Chat webview** (streaming responses, markdown rendering, code blocks with copy/apply, tool‑call cards (collapsible) showing the **router decision** (agent, skills, tools, confidence, with an "edit" control that sends override feedback), approval prompts inline, cancel button, run history).
  - Webview security: strict CSP with nonce, no remote scripts, sanitize markdown, message validation both ways.
  - Views: Agents, Skills, Tools (with enable/disable and risk badges), Tasks (blackboard), Memory search.
  - Status bar item: daemon state + active router backend + pending approvals count.
  - Commands (all in the palette): `Orchestra: Open Chat`, `Ask About Selection`, `Fix Diagnostics Here`, `Explain This File`, `Route Preview (show what router would pick)`, `Doctor`, `Show Audit Log`, `Configure Provider`, `Configure Router Backend`, `Add MCP Server`, `Install Skill From Folder`, `Connect To Team Hub`, `Stop All Runs`.
  - Editor context provider: active file, selection, open editors, diagnostics, git branch/diff; attach to requests with a visible "context chips" row the user can remove.
  - Applying edits: show a **diff view** (`vscode.diff`) for proposed file changes; user accepts or rejects; use `WorkspaceEdit` for applying.
- **Settings** (`contributes.configuration`): provider, model, base URL, router backend, router endpoint/model, permission tiers, sandbox mode, redaction options, hub URL, telemetry (default **off**, and implement none unless opt‑in).
- **Secrets:** API keys via `context.secrets`, never in settings.json.
- Support untrusted workspaces properly (`capabilities.untrustedWorkspaces`: limited mode with exec/write/screen disabled) and virtual workspaces declaration.
- Optionally also register a **Chat Participant** (`@orchestra`) in VS Code's built‑in chat if the API is available, guarded by feature detection. The webview remains the primary UI.
- Packaging: `npm run package` → `orchestra-<version>.vsix` via `vsce` (include LICENSE, README with screenshots placeholders replaced by real descriptions, CHANGELOG, icon). Verify with `vsce ls` that no secrets/tests/source maps with absolute paths are included. Also publish steps for Open VSX documented.
- **Tests (`@vscode/test-electron`):** activates without error; commands registered; daemon starts and `status` RPC returns OK with the mock provider; sending a chat message with the mock LLM streams a response; an approval request appears and approve/deny both work; a proposed edit opens a diff; settings are respected; untrusted‑workspace mode disables dangerous tools.

## 11. CLI and developer UX
- `npm install && npm run build && npm run verify` works from a clean clone.
- `npm run dev` starts watchers; F5 launch config for the Extension Development Host and a debug config for the daemon.
- README quickstart: install the `.vsix`, set provider, first task in 5 steps, plus how to use Ollama with no API key.
- `docs/ARCHITECTURE.md` includes a mermaid diagram; `docs/ROUTER.md` includes data format, training, eval, and serving instructions.

## 12. Observability
Structured logs (pino) with redaction, per‑run trace id, a `runs` table with token usage and cost estimate, and a `orchestra stats` command (routing accuracy via user overrides, tool error rates, average steps).

## 13. Verification — build `npm run verify` and run it

`scripts/verify.mjs` runs every check below in order, prints PASS/FAIL/SKIP (with reason) per check, writes `docs/VERIFICATION_REPORT.md`, and exits non‑zero on any FAIL. Required checks:

1. Clean install + build + typecheck + lint (all packages).
2. All unit tests (`vitest`), all Python tests (`pytest`).
3. Security suite (§8.8).
4. Skill loader + registry tests; MCP fixture server test.
5. Agent runtime integration tests with the mock LLM (tool loop, delegation, cancellation, budget).
6. Router: golden prompt parity (TS vs Python), eval of bm25/embedding/ensemble on the test set with thresholds from §7.5, latency check.
7. **Fine‑tune smoke test:** `gen_data --small` → `train_lora --smoke --cpu` → `export` → `eval_router` on the produced model, which must run end to end (SKIP only if Python ML deps cannot be installed, with the reason).
8. Screen pipeline with the fake CLI shim, including `STALE_REF` retry and redaction; real `agent-browser` test against a local static page if installable, else SKIP with reason; real `agent-desktop` smoke (`list-apps`, one `snapshot`) if installable and a display or permissions exist, else SKIP with reason.
9. Hub e2e: two daemons collaborate via the hub (task post → pickup → result), plus auth/ACL negative tests.
10. Daemon e2e via CLI: `orchestra chat --provider mock "…"` completes a multi‑step task that routes, calls ≥ 2 tools, delegates once, and writes a file inside a temp workspace; the file contents are asserted.
11. Extension: build, package `.vsix`, `vsce ls` inspection, and the `@vscode/test-electron` suite (SKIP only if Electron can't launch in the environment, with the reason; if so also run the extension's logic tests with a mocked `vscode` module).
12. `orchestra doctor` runs and reports sensibly.
13. **Real‑model check (optional, only if keys/Ollama present):** run three realistic tasks end to end (explain a file, fix a failing unit test in a fixture repo, summarize a local web page via agent-browser) and record the transcripts and outcomes in the report. If no real model is available, say so plainly.

## 14. Definition of Done (all must be true, with evidence)

- [ ] Fresh clone → `npm install && npm run build && npm run verify` → exit code 0 (SKIPs allowed only with documented reasons that are environmental, never because code is missing).
- [ ] `.vsix` builds and installs in VS Code; chat works against the mock provider and against at least one real/OpenAI‑compatible provider if available.
- [ ] Router picks agent/skills/tools for a ≥ 60‑tool catalog and meets §7.5 thresholds for the backends that were actually run.
- [ ] Fine‑tune pipeline proven end to end in smoke mode; README explains the full GPU run.
- [ ] Screen reading works through agent-desktop (MCP) and agent-browser wrappers, with stale‑ref retry, redaction, and untrusted‑content handling, proven via the shim and real tools where available.
- [ ] Policy engine, approvals, sandbox, taint tracking, redaction, and audit are active and tested; no dangerous tool runs without passing through them.
- [ ] Two‑daemon hub collaboration demonstrated.
- [ ] All docs written; `VERIFICATION_REPORT.md` contains real command output, a table of PASS/FAIL/SKIP, and a candid "what is not verified" section.

## 15. Final response format (what you print when done)

1. One‑paragraph summary of what was built.
2. The PASS/FAIL/SKIP table from the verification run.
3. Exact commands to: build, run the daemon, install the extension, run a first task, run the router eval, run the full fine‑tune on a GPU.
4. Known limits and unverified areas, stated plainly.
5. The three most valuable next steps.

Start now with Phase 1. Do not ask for confirmation between phases.

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
