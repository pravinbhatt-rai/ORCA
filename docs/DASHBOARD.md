# Dashboard

Start the service with `npm start`, then open `http://127.0.0.1:4173`. The loopback dashboard opens directly without authentication. Pages are canvas, overview, runs/inspector, agents, skills, tools, connectors, memory, tasks, approvals, router, lifecycle, updates, audit, and settings.

All live records come from the local API and SQLite. The visible connector cards and update entries describe current configuration; they do not imply a connected account or available update. The static UI uses local assets only. Large collections are bounded by API pagination (250 maximum); virtual scrolling and 20,000-run scale validation remain outstanding.
