# Project Instructions: pi-tmux-sidechat

Build a Pi extension for `/scc` = “side-chat connect”.

Hard constraints:
- Do not use intercom for `/scc`.
- Do not send messages, asks, or keys to the main Pi session.
- Do not pollute the main session context.
- The side-chat only reads the main session file from disk.
- Never resolve target sessions by cwd alone; candidate Pi panes must be in the current tmux window.
- Prefer the minimal v1: one extension file, no heartbeat, no new dependencies, no custom orchestrator, no custom footer.

Implementation preferences:
- Use Pi extension APIs and Node stdlib.
- Use `pi.exec("tmux", [...])`, not shell, for tmux discovery.
- Use Pi’s normal status API: `ctx.ui.setStatus("scc", text)`.
- Use `before_agent_start` or equivalent hook for context injection.
- Persist side-chat target state with `pi.appendEntry("scc_state", data)` and reconstruct from current branch on `session_start`.
- Enforce read-only mode after connect with `pi.setActiveTools(...)` plus a `tool_call` guard.
- Disable `edit` and `write`; prefer removing `bash` entirely for v1.

Docs to consult before implementation:
- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`
- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
- `docs/scc-objective.md`
