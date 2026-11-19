# Orchestra

Orchestra is a local-first agent orchestration workbench. This repository contains a working Node.js service, SQLite-backed local state, a restrained web dashboard, a lexical catalog router, an approval queue, task board, memory notes, run inspector, and append-only audit records.

## Run locally

Requirements: Node.js 22 or later. No npm packages or API keys are needed.

```sh
npm run build
npm start
```

Open `http://127.0.0.1:4173`. The loopback dashboard opens directly without a login token. State is stored in `~/.orchestra/orchestra.sqlite`; set `ORCHESTRA_HOME` to use another private data directory and `ORCHESTRA_PORT` to choose another port.

Use **New run** to route a task, create a persisted run, build a validated worker plan, and inspect its dependency stages, live worker events, shared blackboard, and final result. Independent stages run up to three workers concurrently; prerequisite stages wait for dependencies. Workers can send run-scoped messages and publish/read shared state. The default mock provider stays offline. To opt into a provider, set `ORCHESTRA_PROVIDER=openai-compatible`, `ORCHESTRA_BASE_URL`, `ORCHESTRA_MODEL`, and optionally `ORCHESTRA_API_KEY`; or set `ORCHESTRA_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Environment variables are read at daemon startup. Read/list/search, task and memory actions, and git inspection tools are available. Filesystem writes pause for approval and return their result to the same model turn. Pending approvals and encrypted model/tool continuation state survive daemon restart; approval decisions remain bound to the original argument hash, and expired approvals are denied. Continuation encryption uses a random 32-byte key in the private `ORCHESTRA_HOME/checkpoint.key` file (mode 0600). Use **Router** to preview catalog selection, **Approvals** to review exact redacted arguments, and **Task board** to track work. The audit page exports local records as JSON.

## Verification

```sh
npm test
npm run verify
```

`npm run verify` rebuilds, runs the core security tests, and checks the tracked implementation backlog. It exits nonzero while any tracked requirement remains open, and writes [`docs/VERIFICATION_REPORT.md`](docs/VERIFICATION_REPORT.md) with command output and the outstanding items. External providers and integrations are reported as unavailable until implemented and configured.

## Architecture

- `packages/daemon/src/server.mjs`: loopback HTTP API, SQLite schema, authentication, session/CSRF checks, bounded collection reads, and audit events.
- `packages/daemon/src/core.mjs`, `llm.mjs`, `runtime.mjs`: lexical router, provider adapters, bounded agent loop, policy checks, redaction, untrusted-content wrappers, and path-jailed read tools.
- `packages/dashboard/public`: static local dashboard with no remote scripts, fonts, or service calls.
- `docs/`: decisions, threat boundaries, operating notes, and known limitations.

See [BUILD_PROMPT.md](BUILD_PROMPT.md) and [ADDENDUM_PROMPT.md](ADDENDUM_PROMPT.md) for the full target system. This implementation is a working foundation, not a claim that all requested integrations and scale targets are already complete.

The active requirements backlog is in [docs/IMPLEMENTATION_TODO.md](docs/IMPLEMENTATION_TODO.md); the full 50-area implementation audit and acceptance criteria are in [docs/REPOSITORY_AUDIT.md](docs/REPOSITORY_AUDIT.md).
