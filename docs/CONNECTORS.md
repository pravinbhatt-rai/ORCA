# Connectors

No provider connector is enabled in this foundation. In particular, there is no Gmail OAuth client, API call, token store, or refresh flow, so this build cannot access a Google account. The dashboard connector cards explain this state.

For a future personal Gmail setup, create an OAuth client in a Google Cloud project, enable the Gmail API, keep client secrets outside the repository, and request read-only scopes first. Gmail send, modify, and archive scopes are sensitive/restricted; current Google verification and testing-mode rules must be checked against the official Google documentation at implementation time. This project does not assert a refresh-token lifetime because it has not verified or implemented that flow.

Manual checklist once implemented: create a dedicated OAuth client; configure callback to loopback; grant read-only scopes; verify displayed scopes; test search and thread read against a non-sensitive message; separately grant draft/write; inspect exact recipient, subject, and body before sending; verify revoke removes local access. Current real-account check: **not run; connector does not exist**.
# MCP server support

The local daemon supports custom MCP servers over stdio. New entries are stored as untrusted and disabled; an operator must explicitly trust and enable one, select allowed agent IDs, and connect it. Imported tools use `mcp.<server>.<tool>` names and retain the configured risk tier. Environment variable names are allow-listed in configuration while values are read from the daemon environment and never persisted. The working directory is resolved inside the Orchestra workspace.

The implementation uses the official `@modelcontextprotocol/sdk`. The Tools & MCP page can add, trust/connect, disconnect, and remove a server. Current limits: Streamable HTTP transport and OAuth, exponential reconnect/backoff, management UI for editing grants after setup, and full plugin/service connectors are not implemented. See [IMPLEMENTATION_TODO.md](IMPLEMENTATION_TODO.md).
