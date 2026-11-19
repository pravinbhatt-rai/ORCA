# Verification report

Run date: 2026-11-19T03:02:36.719Z

| Check | Result |
|---|---|
| Build | PASS |
| Runtime, security, and HTTP integration tests | PASS |
| Native darwin secret-store integration | PASS |
| Implementation requirements audit | FAIL |

## Command output

### Build

```text
> orchestra-local@0.1.0 build
> node --check packages/daemon/src/server.mjs && node --check packages/daemon/src/core.mjs && node --check packages/daemon/src/errors.mjs && node --check packages/daemon/src/llm.mjs && node --check packages/daemon/src/runtime.mjs && node --check packages/daemon/src/tool-registry.mjs && node --check packages/daemon/src/migrations.mjs && node --check packages/daemon/src/checkpoint-store.mjs && node --check packages/daemon/src/secrets.mjs && node --check packages/daemon/src/connectors/mcp-manager.mjs && node --check packages/dashboard/public/app.js
```

### Runtime, security, and HTTP integration tests

```text
> orchestra-local@0.1.0 test
> node --test

TAP version 13
# Subtest: redacts credentials and email addresses recursively
ok 1 - redacts credentials and email addresses recursively
  ---
  duration_ms: 1.747
  type: 'test'
  ...
# Subtest: policy forces approval for risky action following untrusted input
ok 2 - policy forces approval for risky action following untrusted input
  ---
  duration_ms: 0.548833
  type: 'test'
  ...
# Subtest: typed policy matrix covers every registered tool, mode, taint state, and risk
ok 3 - typed policy matrix covers every registered tool, mode, taint state, and risk
  ---
  duration_ms: 0.621292
  type: 'test'
  ...
# Subtest: policy configuration validates tier/tool/workspace overrides and applies them by specificity
ok 4 - policy configuration validates tier/tool/workspace overrides and applies them by specificity
  ---
  duration_ms: 1.042959
  type: 'test'
  ...
# Subtest: approval argument hash is stable and changes with the reviewed content
ok 5 - approval argument hash is stable and changes with the reviewed content
  ---
  duration_ms: 7.827208
  type: 'test'
  ...
# Subtest: router selects relevant agent and bounded catalog tools
ok 6 - router selects relevant agent and bounded catalog tools
  ---
  duration_ms: 1.263875
  type: 'test'
  ...
# Subtest: untrusted content is marked at the context boundary
ok 7 - untrusted content is marked at the context boundary
  ---
  duration_ms: 0.337292
  type: 'test'
  ...
# Subtest: typed request errors have stable status, code, request ID, and remediation
ok 8 - typed request errors have stable status, code, request ID, and remediation
  ---
  duration_ms: 1.501459
  type: 'test'
  ...
# Subtest: internal error and cause details never escape public errors
ok 9 - internal error and cause details never escape public errors
  ---
  duration_ms: 0.669959
  type: 'test'
  ...
# Subtest: provider endpoint validation permits loopback HTTP and blocks unsafe targets
ok 10 - provider endpoint validation permits loopback HTTP and blocks unsafe targets
  ---
  duration_ms: 6.899042
  type: 'test'
  ...
# Subtest: OpenAI-compatible adapter round-trips tools, usage, profile limits, and timeout
ok 11 - OpenAI-compatible adapter round-trips tools, usage, profile limits, and timeout
  ---
  duration_ms: 288.905209
  type: 'test'
  ...
# Subtest: ProviderManager applies profile settings and records runtime token usage
ok 12 - ProviderManager applies profile settings and records runtime token usage
  ---
  duration_ms: 5.866958
  type: 'test'
  ...
# (node:83030) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: MCP stdio manager imports namespaced tools and enforces trust and agent grants
ok 13 - MCP stdio manager imports namespaced tools and enforces trust and agent grants
  ---
  duration_ms: 195.825875
  type: 'test'
  ...
# Subtest: MCP configuration rejects unsafe environment names and workspace escapes
ok 14 - MCP configuration rejects unsafe environment names and workspace escapes
  ---
  duration_ms: 7.56625
  type: 'test'
  ...
# (node:83031) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: schema migration upgrades the inline schema and is safe to run repeatedly
ok 15 - schema migration upgrades the inline schema and is safe to run repeatedly
  ---
  duration_ms: 17.35825
  type: 'test'
  ...
# Subtest: failed migration rolls back schema changes and leaves its version unapplied
ok 16 - failed migration rolls back schema changes and leaves its version unapplied
  ---
  duration_ms: 3.839667
  type: 'test'
  ...
# Subtest: checkpoint state is authenticated, encrypted at rest, and survives reopening
ok 17 - checkpoint state is authenticated, encrypted at rest, and survives reopening
  ---
  duration_ms: 23.074292
  type: 'test'
  ...
# Subtest: website task plan selects only available workers and orders review after implementation
ok 18 - website task plan selects only available workers and orders review after implementation
  ---
  duration_ms: 2.675125
  type: 'test'
  ...
# Subtest: LLM plan validation rejects invented agents and dependency cycles
ok 19 - LLM plan validation rejects invented agents and dependency cycles
  ---
  duration_ms: 0.801792
  type: 'test'
  ...
# Subtest: planner computes dependency waves and rejects malformed or oversized dependency lists
ok 20 - planner computes dependency waves and rejects malformed or oversized dependency lists
  ---
  duration_ms: 0.610084
  type: 'test'
  ...
# Subtest: planner falls back to available general agent without inventing IDs
ok 21 - planner falls back to available general agent without inventing IDs
  ---
  duration_ms: 1.939167
  type: 'test'
  ...
# (node:83033) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: agent runtime handles a scripted read-only tool call
ok 22 - agent runtime handles a scripted read-only tool call
  ---
  duration_ms: 17.711875
  type: 'test'
  ...
# Subtest: runtime audits a typed policy decision with tool risk and execution context
ok 23 - runtime audits a typed policy decision with tool risk and execution context
  ---
  duration_ms: 5.853958
  type: 'test'
  ...
# Subtest: runtime error events use sanitized taxonomy while model context receives the tool error
ok 24 - runtime error events use sanitized taxonomy while model context receives the tool error
  ---
  duration_ms: 3.075333
  type: 'test'
  ...
# Subtest: agent runtime pauses writes and rejects workspace traversal
ok 25 - agent runtime pauses writes and rejects workspace traversal
  ---
  duration_ms: 3.723167
  type: 'test'
  ...
# Subtest: shell command uses an argument array in a no-network sandbox and enforces timeout/output bounds
ok 26 - shell command uses an argument array in a no-network sandbox and enforces timeout/output bounds
  ---
  duration_ms: 271.667458
  type: 'test'
  ...
# Subtest: runtime applies per-workspace policy modes and denies before requesting approval
ok 27 - runtime applies per-workspace policy modes and denies before requesting approval
  ---
  duration_ms: 4.110208
  type: 'test'
  ...
# Subtest: an approved write resumes the same run and returns its result to the model
ok 28 - an approved write resumes the same run and returns its result to the model
  ---
  duration_ms: 3.807875
  type: 'test'
  ...
# Subtest: an encrypted checkpoint resumes an approved tool call in a fresh runtime
ok 29 - an encrypted checkpoint resumes an approved tool call in a fresh runtime
  ---
  duration_ms: 9.885458
  type: 'test'
  ...
# Subtest: a denied checkpointed approval stays denied if the policy later changes to allow
ok 30 - a denied checkpointed approval stays denied if the policy later changes to allow
  ---
  duration_ms: 2.061542
  type: 'test'
  ...
# Subtest: filesystem search is bounded and exact edit rejects ambiguous matches
ok 31 - filesystem search is bounded and exact edit rejects ambiguous matches
  ---
  duration_ms: 3.106208
  type: 'test'
  ...
# Subtest: approved file edit replay recognizes the already-applied result without rewriting it
ok 32 - approved file edit replay recognizes the already-applied result without rewriting it
  ---
  duration_ms: 3.992084
  type: 'test'
  ...
# Subtest: git inspection uses argument arrays and returns bounded workspace output
ok 33 - git inspection uses argument arrays and returns bounded workspace output
  ---
  duration_ms: 49.575917
  type: 'test'
  ...
# Subtest: runtime returns cancelled when signal is already aborted
ok 34 - runtime returns cancelled when signal is already aborted
  ---
  duration_ms: 0.402041
  type: 'test'
  ...
# Subtest: tainted dependency context cannot trigger an automatic write
ok 35 - tainted dependency context cannot trigger an automatic write
  ---
  duration_ms: 1.618333
  type: 'test'
  ...
# Subtest: workers exchange scoped messages and shared blackboard values through runtime tools
ok 36 - workers exchange scoped messages and shared blackboard values through runtime tools
  ---
  duration_ms: 205.694584
  type: 'test'
  ...
# Subtest: blackboard enforces assigned-task scope and key ACLs with provenance history
ok 37 - blackboard enforces assigned-task scope and key ACLs with provenance history
  ---
  duration_ms: 1.835667
  type: 'test'
  ...
# Subtest: parallel workers share a hard token reservation budget
ok 38 - parallel workers share a hard token reservation budget
  ---
  duration_ms: 0.450125
  type: 'test'
  ...
# Subtest: native OS credential vault stores, reads, rotates and deletes without argv secrets
ok 39 - native OS credential vault stores, reads, rotates and deletes without argv secrets # SKIP run through npm run verify to exercise OS vault
  ---
  duration_ms: 0.792916
  type: 'test'
  ...
# Subtest: darwin secret adapter keeps credentials off process arguments and round-trips
ok 40 - darwin secret adapter keeps credentials off process arguments and round-trips
  ---
  duration_ms: 1.606209
  type: 'test'
  ...
# Subtest: linux secret adapter keeps credentials off process arguments and round-trips
ok 41 - linux secret adapter keeps credentials off process arguments and round-trips
  ---
  duration_ms: 0.311291
  type: 'test'
  ...
# Subtest: win32 secret adapter keeps credentials off process arguments and round-trips
ok 42 - win32 secret adapter keeps credentials off process arguments and round-trips
  ---
  duration_ms: 0.4105
  type: 'test'
  ...
# Subtest: VS Code adapter delegates store, read, rotation and delete to SecretStorage
ok 43 - VS Code adapter delegates store, read, rotation and delete to SecretStorage
  ---
  duration_ms: 0.376542
  type: 'test'
  ...
# (node:83037) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: local API protects data and binds approval to exact arguments
ok 44 - local API protects data and binds approval to exact arguments
  ---
  duration_ms: 2330.56475
  type: 'test'
  ...
# Subtest: pending approval survives a daemon restart and resumes the same worker turn
ok 45 - pending approval survives a daemon restart and resumes the same worker turn
  ---
  duration_ms: 1295.038208
  type: 'test'
  ...
# Subtest: built-in registry exposes validated executable schemas and truthful availability
ok 46 - built-in registry exposes validated executable schemas and truthful availability
  ---
  duration_ms: 1.398792
  type: 'test'
  ...
# Subtest: registry validates implementation results against output schemas
ok 47 - registry validates implementation results against output schemas
  ---
  duration_ms: 0.725916
  type: 'test'
  ...
# Subtest: registry binds execution grants to policy and exact arguments
ok 48 - registry binds execution grants to policy and exact arguments
  ---
  duration_ms: 1.130542
  type: 'test'
  ...
1..48
# tests 48
# suites 0
# pass 47
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 5296.473666
```

### Native darwin secret-store integration

```text
TAP version 13
# Subtest: native OS credential vault stores, reads, rotates and deletes without argv secrets
ok 1 - native OS credential vault stores, reads, rotates and deletes without argv secrets
  ---
  duration_ms: 862.401041
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 929.383333
```

### Implementation requirements audit

```text
33 tracked implementation requirements remain open; 12 are closed.
OPEN: Cross-platform secret storage: native adapters now use macOS Security.framework (Swift helper with the value on stdin), Linux Secret Service (`secret-tool` stdin), and Windows Credential Manager (`CredWrite` through PowerShell with JSON on stdin); a VS Code `SecretStorage` adapter is provided. Mock adapter tests cover store/read/rotate/delete and prove credentials are absent from argv; `npm run verify` performs a real macOS Keychain round trip on this host. Still needs real Linux/Windows vault runs, extension-host wiring to `SecretStorage`, and end-to-end leak scans across DB/log/crash/export/process snapshots.
OPEN: Provider profile security/configuration: profile create/edit/enable/default/test/delete UI and API now round-trip timeout, token and temperature settings; keys expose only a masked suffix; provider-test latency/error and runtime token usage persist. HTTPS/loopback URL validation rejects private IP literals and private DNS answers; adapters enforce bounded request timeouts. Unit/HTTP tests cover endpoint rejection, fake protocol/tool round-trip, timeout, profile settings, key rotation/masking/leak scans on macOS, safe error state, and a selected-profile run. Still needs DNS-rebinding protections, normal-run latency/error health state, and native vault profile/leak tests on Linux/Windows.
OPEN: Shell sandbox: macOS sandbox-exec and Linux bubblewrap runners deny network access and restrict writes to the workspace; execution uses argument arrays and enforces approval, a 10-second ceiling, cancellation, and a 256 KB output bound. Shell strings (`sh -c`) and obvious destructive commands (`rm`, disk tools, destructive Git/find forms) are rejected before launch. macOS tests cover argv separation, denied loopback networking, timeout, cancellation, destructive-command rejection, and an explicit 300 KB output-cap fixture. Still needs verified Linux coverage, CPU/memory limits, and workspace/sandbox escape fixtures.
OPEN: Error taxonomy: added typed `OrchestraError` subclasses and shared error serialization. Every HTTP error response now uses the same code/requestId/message/suggestion envelope; unhandled 5xx details and causes are hidden. Malformed JSON, oversized bodies, auth/CSRF, not-found, conflict, host rejection, and provider failures have HTTP fixtures. Runtime/SSE error events and orchestration recovery audits use sanitized public errors while tool details remain available inside the model loop. Still needs an exhaustive route/status inventory, end-to-end fixture for every typed class, and broader failure injection across provider/runtime/SSE boundaries.
OPEN: Verification gates: make `npm run verify` report every implemented suite as PASS/FAIL and environment-dependent integrations as explicit SKIP; missing required implementation must fail the gate. Acceptance: clean checkout verification plus injected failing Python/browser/security check.
OPEN: Local orchestration canvas and saved workflows (user brief, 2026-11-19): landing canvas renders active parent/worker cards, SVG dependency edges and readable dependency links, provider/tools/messages and workspace file artifacts in a hover inspector, actual runtime provider/model, per-agent and per-run provider selection, direct agent assignment, and multi-step workflow create/edit/save/reopen/run controls. Active canvas runs subscribe to named SSE events and refresh on updates with a 12-second polling fallback; subscriptions close on completion/navigation/logout. Server tests persist/edit/run a two-step workflow, prove per-agent/per-task profiles reach fake-provider workers, prove run-level provider override reaches planner and workers, confirm automatic research routes to a DeepSeek-named profile and exposes the actual model, and confirm an approved file write appears as a canvas artifact. Manual browser smoke created/reopened/edited a multi-step flow. Still required: plugin/connector attribution, repeatable browser E2E covering edge/artifact rendering, SSE refresh and manual/automatic Claude/DeepSeek/OpenAI-compatible workflows.
OPEN: Provider adapters: dedicated OpenAI, native Ollama, and tested OpenAI-compatible/Anthropic implementations, with fake-server protocol, tool round-trip, timeout, usage, cancellation, and error fixtures. Acceptance: configured fake provider runs a complete tool task; optional local Ollama run reports a reasoned skip only when unavailable.
OPEN: Complete provider settings UI: profile CRUD/default/test and health/usage display exist; assigned agent/provider routing is now integration-tested through a real fake-provider call. Disabling or deleting an assigned provider safely resets those agents to automatic routing. Remaining: browser round-trip for every setting, normal-run latency/error health metrics, DNS-rebinding protections, and complete native-vault leak scans on Linux/Windows. Acceptance: UI round-trips every persisted field and a selected profile is used by runtime.
OPEN: Agent-initiated delegation: bounded delegate tool, max depth, cycle prevention, global concurrency/step/token/cost budgets, retry policy, and cancellation propagation. Acceptance: nested worker delegation respects limits, rejects cycles, retries a transient failure once, and cancels all descendants.
OPEN: Durable message delivery: messages now persist correlation IDs and bounded request expirations; replies must match an unexpired request addressed to the sender. Per-run/per-agent SQLite read cursors prevent repeat delivery, and inbox supports bounded long-poll wait with cancellation. Runtime tests cover request/reply, ordered one-time consumption, and cursor persistence. Concurrent-worker/restart integration and delivery stress tests remain open.
OPEN: Blackboard policy: key-level read/write ACL, versioned provenance history, and assigned-task key namespaces are migrated and enforced; supervisors can grant per-agent read/write rights through the API and dashboard. Workers are told to prefix keys with their assigned task; cross-task access requires an explicit ACL. Conflicts use versioned last-writer-wins. Runtime/HTTP tests verify cross-scope deny, explicit cross-task read grant, denied write grant, history, and ACL updates. Browser E2E, concurrent conflict stress, and ACL isolation across worker restarts remain open.
OPEN: Catalog scale: seed and validate at least 100 distinct agent profiles and 200 distinct skill definitions with metadata, permissions, examples, duplicate ceiling, and provenance. Acceptance: loaders reject malformed/duplicate entries and router retrieval returns the right profile under benchmark corpus.
OPEN: Two-stage router: family/category selection then bounded agent/tool/skill selection, with measured BM25 or trained-model fallback and routing log. Acceptance: golden corpus meets documented precision/recall/latency, unknown task falls back safely, and inactive capabilities are clamped.
OPEN: OAuth/PKCE connector foundation and Gmail: state/verifier callback, least-privilege scopes, refresh/revoke, secure tokens, search/read/draft and approval-gated send. Acceptance: fake OAuth/Gmail server covers CSRF/state, exchange, refresh, revoke, tainted email text, and exact send approval.
OPEN: MCP client lifecycle: stdio trusted-server configuration, process lifecycle, namespaced schema import, per-agent grants, timeout, retry and policy gating now have API/dashboard controls, an in-repo SDK fixture for discovery/calls/untrusted blocking, and provider/source attribution in the canvas inspector. Still open: Streamable HTTP transport, exponential reconnect/backoff and health recovery tests, collision/error fixtures, dashboard wizard polish, and doctor integration.
OPEN: VS Code extension: real extension package, daemon RPC, chat/run view, approvals, workspace restriction, and SecretStorage. Acceptance: package VSIX and run `@vscode/test-electron` activation/chat/approval/workspace tests.
OPEN: Dashboard completion: full edge graph, agent details, approval resume, artifact list/diff and message/blackboard history. Acceptance: browser scenario verifies all controls against persisted server state.
OPEN: Event stream recovery: SSE now emits IDs, accepts `Last-Event-ID`/`after`, replays strictly after the cursor in SQLite insertion order, buffers events during replay to avoid the subscribe/replay race, and removes listeners on response close. Reconnect replay is HTTP-tested. Retention policy, slow-client backpressure, multi-client stress and bounded event storage remain open.
OPEN: Server-side collection filters/cursors: query filters, stable cursor pagination, bounded totals and indexes. Acceptance: large fixture verifies no duplicates/omissions while paging and filtering.
OPEN: End-to-end scenario suite: run a portfolio/e-commerce request through planning, worker handoff, actual workspace artifact, tests, review, approval and dashboard result. Acceptance: Playwright asserts artifacts and persisted timeline, not just labels.
OPEN: Browser tools: bounded search/fetch plus browser session actions and untrusted-result wrapping. Acceptance: fake-browser tests cover stale references, timeout, session isolation and close-on-error.
OPEN: Desktop tools: platform accessibility snapshot/actions through explicit app allowlist and permission handling. Acceptance: fake desktop CLI covers snapshot/click/stale element/redaction and environment-gated real smoke.
OPEN: Calendar/Drive/GitHub/Slack connectors: reuse connector grants and approval policy, with fake service fixtures. Acceptance: each connector supports least-privilege read and exact reviewed writes/revocation.
OPEN: Lifecycle manager: evidence-backed proposals that mutate versioned agent/skill/tool library only on approval. Acceptance: approve/reject/snooze changes real state reversibly and emits audit evidence.
OPEN: Skill Forge: draft, validate schema/permissions/secrets/duplicates, sandbox examples, route evaluation and human review. Acceptance: invalid permission, secret, duplicate, and router regression fixtures are rejected.
OPEN: Agent/skill version history and rollback: immutable versions, diffs, runtime/catalog hash restoration. Acceptance: edit, view diff, roll back, and verify router/runtime return to prior version.
OPEN: Janitor: usage/evidence-based stale proposal generation with protected pinned/bundled/dependent records. Acceptance: synthetic history proposes only eligible records and cannot remove protected records.
OPEN: Accessibility: semantic structure, keyboard/focus behavior, contrast and screen reader labels. Acceptance: axe has zero critical violations and keyboard-only E2E passes core workflows.
OPEN: Performance at scale: seed 150 agents, 400 skills, 80 tools, and 20,000 runs; virtualize lists and measure retrieval. Acceptance: first paint under 1 second, query p95 under 50 ms, and documented scroll performance target.
OPEN: Signed updater: signed manifest verification, staged install, compatibility/downgrade policy, health check and rollback. Acceptance: fake update server rejects unsigned/tampered/widened/downgrade packages and restores a failed install.
OPEN: Router training pipeline: small-data generation, CPU training/evaluation/export and reproducible dataset versioning. Acceptance: documented `gen_data --small`, train, eval and export commands execute and report measured thresholds.
OPEN: Remote team hub and multi-user ACLs, only after local identity, event authorization and cross-device sync design are implemented. Acceptance: isolated users cannot access another user's runs, messages, keys or blackboard.
OPEN: Packaging/release pipeline: reproducible daemon/dashboard/extension distribution, migration smoke and signed release artifact verification. Acceptance: clean install, upgrade, rollback and uninstall fixtures pass on supported OSes.
```

## Outstanding requirements

- [ ] Cross-platform secret storage: native adapters now use macOS Security.framework (Swift helper with the value on stdin), Linux Secret Service (`secret-tool` stdin), and Windows Credential Manager (`CredWrite` through PowerShell with JSON on stdin); a VS Code `SecretStorage` adapter is provided. Mock adapter tests cover store/read/rotate/delete and prove credentials are absent from argv; `npm run verify` performs a real macOS Keychain round trip on this host. Still needs real Linux/Windows vault runs, extension-host wiring to `SecretStorage`, and end-to-end leak scans across DB/log/crash/export/process snapshots.
- [ ] Provider profile security/configuration: profile create/edit/enable/default/test/delete UI and API now round-trip timeout, token and temperature settings; keys expose only a masked suffix; provider-test latency/error and runtime token usage persist. HTTPS/loopback URL validation rejects private IP literals and private DNS answers; adapters enforce bounded request timeouts. Unit/HTTP tests cover endpoint rejection, fake protocol/tool round-trip, timeout, profile settings, key rotation/masking/leak scans on macOS, safe error state, and a selected-profile run. Still needs DNS-rebinding protections, normal-run latency/error health state, and native vault profile/leak tests on Linux/Windows.
- [ ] Shell sandbox: macOS sandbox-exec and Linux bubblewrap runners deny network access and restrict writes to the workspace; execution uses argument arrays and enforces approval, a 10-second ceiling, cancellation, and a 256 KB output bound. Shell strings (`sh -c`) and obvious destructive commands (`rm`, disk tools, destructive Git/find forms) are rejected before launch. macOS tests cover argv separation, denied loopback networking, timeout, cancellation, destructive-command rejection, and an explicit 300 KB output-cap fixture. Still needs verified Linux coverage, CPU/memory limits, and workspace/sandbox escape fixtures.
- [ ] Error taxonomy: added typed `OrchestraError` subclasses and shared error serialization. Every HTTP error response now uses the same code/requestId/message/suggestion envelope; unhandled 5xx details and causes are hidden. Malformed JSON, oversized bodies, auth/CSRF, not-found, conflict, host rejection, and provider failures have HTTP fixtures. Runtime/SSE error events and orchestration recovery audits use sanitized public errors while tool details remain available inside the model loop. Still needs an exhaustive route/status inventory, end-to-end fixture for every typed class, and broader failure injection across provider/runtime/SSE boundaries.
- [ ] Verification gates: make `npm run verify` report every implemented suite as PASS/FAIL and environment-dependent integrations as explicit SKIP; missing required implementation must fail the gate. Acceptance: clean checkout verification plus injected failing Python/browser/security check.
- [ ] Local orchestration canvas and saved workflows (user brief, 2026-11-19): landing canvas renders active parent/worker cards, SVG dependency edges and readable dependency links, provider/tools/messages and workspace file artifacts in a hover inspector, actual runtime provider/model, per-agent and per-run provider selection, direct agent assignment, and multi-step workflow create/edit/save/reopen/run controls. Active canvas runs subscribe to named SSE events and refresh on updates with a 12-second polling fallback; subscriptions close on completion/navigation/logout. Server tests persist/edit/run a two-step workflow, prove per-agent/per-task profiles reach fake-provider workers, prove run-level provider override reaches planner and workers, confirm automatic research routes to a DeepSeek-named profile and exposes the actual model, and confirm an approved file write appears as a canvas artifact. Manual browser smoke created/reopened/edited a multi-step flow. Still required: plugin/connector attribution, repeatable browser E2E covering edge/artifact rendering, SSE refresh and manual/automatic Claude/DeepSeek/OpenAI-compatible workflows.
- [ ] Provider adapters: dedicated OpenAI, native Ollama, and tested OpenAI-compatible/Anthropic implementations, with fake-server protocol, tool round-trip, timeout, usage, cancellation, and error fixtures. Acceptance: configured fake provider runs a complete tool task; optional local Ollama run reports a reasoned skip only when unavailable.
- [ ] Complete provider settings UI: profile CRUD/default/test and health/usage display exist; assigned agent/provider routing is now integration-tested through a real fake-provider call. Disabling or deleting an assigned provider safely resets those agents to automatic routing. Remaining: browser round-trip for every setting, normal-run latency/error health metrics, DNS-rebinding protections, and complete native-vault leak scans on Linux/Windows. Acceptance: UI round-trips every persisted field and a selected profile is used by runtime.
- [ ] Agent-initiated delegation: bounded delegate tool, max depth, cycle prevention, global concurrency/step/token/cost budgets, retry policy, and cancellation propagation. Acceptance: nested worker delegation respects limits, rejects cycles, retries a transient failure once, and cancels all descendants.
- [ ] Durable message delivery: messages now persist correlation IDs and bounded request expirations; replies must match an unexpired request addressed to the sender. Per-run/per-agent SQLite read cursors prevent repeat delivery, and inbox supports bounded long-poll wait with cancellation. Runtime tests cover request/reply, ordered one-time consumption, and cursor persistence. Concurrent-worker/restart integration and delivery stress tests remain open.
- [ ] Blackboard policy: key-level read/write ACL, versioned provenance history, and assigned-task key namespaces are migrated and enforced; supervisors can grant per-agent read/write rights through the API and dashboard. Workers are told to prefix keys with their assigned task; cross-task access requires an explicit ACL. Conflicts use versioned last-writer-wins. Runtime/HTTP tests verify cross-scope deny, explicit cross-task read grant, denied write grant, history, and ACL updates. Browser E2E, concurrent conflict stress, and ACL isolation across worker restarts remain open.
- [ ] Catalog scale: seed and validate at least 100 distinct agent profiles and 200 distinct skill definitions with metadata, permissions, examples, duplicate ceiling, and provenance. Acceptance: loaders reject malformed/duplicate entries and router retrieval returns the right profile under benchmark corpus.
- [ ] Two-stage router: family/category selection then bounded agent/tool/skill selection, with measured BM25 or trained-model fallback and routing log. Acceptance: golden corpus meets documented precision/recall/latency, unknown task falls back safely, and inactive capabilities are clamped.
- [ ] OAuth/PKCE connector foundation and Gmail: state/verifier callback, least-privilege scopes, refresh/revoke, secure tokens, search/read/draft and approval-gated send. Acceptance: fake OAuth/Gmail server covers CSRF/state, exchange, refresh, revoke, tainted email text, and exact send approval.
- [ ] MCP client lifecycle: stdio trusted-server configuration, process lifecycle, namespaced schema import, per-agent grants, timeout, retry and policy gating now have API/dashboard controls, an in-repo SDK fixture for discovery/calls/untrusted blocking, and provider/source attribution in the canvas inspector. Still open: Streamable HTTP transport, exponential reconnect/backoff and health recovery tests, collision/error fixtures, dashboard wizard polish, and doctor integration.
- [ ] VS Code extension: real extension package, daemon RPC, chat/run view, approvals, workspace restriction, and SecretStorage. Acceptance: package VSIX and run `@vscode/test-electron` activation/chat/approval/workspace tests.
- [ ] Dashboard completion: full edge graph, agent details, approval resume, artifact list/diff and message/blackboard history. Acceptance: browser scenario verifies all controls against persisted server state.
- [ ] Event stream recovery: SSE now emits IDs, accepts `Last-Event-ID`/`after`, replays strictly after the cursor in SQLite insertion order, buffers events during replay to avoid the subscribe/replay race, and removes listeners on response close. Reconnect replay is HTTP-tested. Retention policy, slow-client backpressure, multi-client stress and bounded event storage remain open.
- [ ] Server-side collection filters/cursors: query filters, stable cursor pagination, bounded totals and indexes. Acceptance: large fixture verifies no duplicates/omissions while paging and filtering.
- [ ] End-to-end scenario suite: run a portfolio/e-commerce request through planning, worker handoff, actual workspace artifact, tests, review, approval and dashboard result. Acceptance: Playwright asserts artifacts and persisted timeline, not just labels.
- [ ] Browser tools: bounded search/fetch plus browser session actions and untrusted-result wrapping. Acceptance: fake-browser tests cover stale references, timeout, session isolation and close-on-error.
- [ ] Desktop tools: platform accessibility snapshot/actions through explicit app allowlist and permission handling. Acceptance: fake desktop CLI covers snapshot/click/stale element/redaction and environment-gated real smoke.
- [ ] Calendar/Drive/GitHub/Slack connectors: reuse connector grants and approval policy, with fake service fixtures. Acceptance: each connector supports least-privilege read and exact reviewed writes/revocation.
- [ ] Lifecycle manager: evidence-backed proposals that mutate versioned agent/skill/tool library only on approval. Acceptance: approve/reject/snooze changes real state reversibly and emits audit evidence.
- [ ] Skill Forge: draft, validate schema/permissions/secrets/duplicates, sandbox examples, route evaluation and human review. Acceptance: invalid permission, secret, duplicate, and router regression fixtures are rejected.
- [ ] Agent/skill version history and rollback: immutable versions, diffs, runtime/catalog hash restoration. Acceptance: edit, view diff, roll back, and verify router/runtime return to prior version.
- [ ] Janitor: usage/evidence-based stale proposal generation with protected pinned/bundled/dependent records. Acceptance: synthetic history proposes only eligible records and cannot remove protected records.
- [ ] Accessibility: semantic structure, keyboard/focus behavior, contrast and screen reader labels. Acceptance: axe has zero critical violations and keyboard-only E2E passes core workflows.
- [ ] Performance at scale: seed 150 agents, 400 skills, 80 tools, and 20,000 runs; virtualize lists and measure retrieval. Acceptance: first paint under 1 second, query p95 under 50 ms, and documented scroll performance target.
- [ ] Signed updater: signed manifest verification, staged install, compatibility/downgrade policy, health check and rollback. Acceptance: fake update server rejects unsigned/tampered/widened/downgrade packages and restores a failed install.
- [ ] Router training pipeline: small-data generation, CPU training/evaluation/export and reproducible dataset versioning. Acceptance: documented `gen_data --small`, train, eval and export commands execute and report measured thresholds.
- [ ] Remote team hub and multi-user ACLs, only after local identity, event authorization and cross-device sync design are implemented. Acceptance: isolated users cannot access another user's runs, messages, keys or blackboard.
- [ ] Packaging/release pipeline: reproducible daemon/dashboard/extension distribution, migration smoke and signed release artifact verification. Acceptance: clean install, upgrade, rollback and uninstall fixtures pass on supported OSes.

## Skipped or unavailable checks

- No external provider, OAuth connector, browser automation, desktop accessibility, GPU fine-tune, or VS Code extension package check was run in this invocation. These are not reported as passing.
- See `docs/KNOWN_LIMITS.md` for known implementation gaps and environmental constraints.
