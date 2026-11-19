# Decisions

- **Runtime:** Node.js 22 ESM with built-in `node:sqlite`, HTTP, and crypto. The initial workspace had only the two product prompts and no package lock or dependencies. Built-ins keep the first usable local system installable without network access.
- **Interface:** a local static dashboard served by the daemon. Its visual system uses compact 5px corners, muted colors, and no external assets.
- **Data:** SQLite WAL database under `~/.orchestra`; the user may override the directory with `ORCHESTRA_HOME`. Seed rows are clearly demo starter records, not reports about external connected systems.
- **Local access:** the loopback dashboard opens directly without a bootstrap, login, or session token. Host validation rejects non-loopback host names.
- **Provider:** mock mode is explicit and makes no model calls. No API keys are embedded or persisted.
- **Approval:** policy requests are persisted, pending by default, and bound to a SHA-256 hash of redacted exact arguments. Send-class actions always ask.
- **Scope:** prioritize a runnable secure local core and functional dashboard workflows. External integrations, model tool loops, extension packaging, hub, ML training, and the rest of the scale seed are tracked in `KNOWN_LIMITS.md` rather than simulated as complete.
