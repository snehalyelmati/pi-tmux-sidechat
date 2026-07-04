# `/scc` Objective — Side-chat Connect

Build a Pi extension for `/scc` = “side-chat connect”.

## Goal

In a tmux window with a main Pi pane, user opens a new pane, starts `pi`, runs `/scc`, and this new Pi session becomes a read-only side-chat over the main Pi session’s saved session file.

## Critical constraints

- Do NOT use intercom for `/scc`.
- Do NOT send messages/asks/keys to the main Pi session.
- Do NOT pollute the main session’s context.
- The side-chat only reads main-session content from the main session file on disk.
- Exception: `/scc` may use read-only `tmux capture-pane` to read candidate panes’ visible `chat: <name-or-full-id>` status labels for active-session discovery. It must not send keys/messages.

## Docs to read

- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`
- `/Users/snehalyelmati/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`

## Core `/scc` flow

```text
/scc
 |
 v
detect current tmux pane/window
 |
 v
list panes in current tmux window only
 |
 v
filter panes running Pi, exclude self
 |
 v
if 0: show "No Pi pane found"
if 1: use that pane
if N: ask user which pane
 |
 v
capture candidate pane visible `chat: <name-or-full-id>` status label read-only
 |
 v
get candidate pane cwd
 |
 v
list Pi session files for that cwd and match by exact visible status id/name
 |
 v
if 0: show "No active Pi session found in this tmux window"
if 1: connect
if N: ask user which active session
 |
 v
persist selected sessionFile and bounded snapshot in side-chat state
 |
 v
enable read-only mode
 |
 v
read selected session file once, persist bounded snapshot in side-chat state
```

## Important multi-window rule

Never resolve by cwd alone. Candidate Pi panes must be in the current tmux window id. Same cwd in another tmux window must be ignored.

## No-heartbeat limitation

Without cooperation from the main Pi process, exact mapping:

```text
tmux pane / pid -> exact Pi session file
```

is not guaranteed. For v1, every main pane should load this extension so it displays `chat: <session-name-or-full-id>`. `/scc` reads that visible status label with read-only `tmux capture-pane` and matches it to session files by exact id/name.

## Expected UX

```text
Found Pi pane %34 at /repo.

Pick main session:
1. Fanout MVP review      modified 9s ago
2. Provider integration   modified 6m ago
3. Unnamed                modified 1h ago
```

## Commands

- `/scc` connect or reuse existing connection.
- `/scc --pick` forget current target and reselect.
- Optional `/scc --status` show connected target.

## Read-only enforcement

After `/scc`, side-chat must not be able to modify files.

Implement real enforcement:

- Disable `edit` and `write` with `pi.setActiveTools(...)`.
- Add `tool_call` guard blocking `edit` and `write`.
- Prefer removing `bash` entirely for v1.
- If keeping `bash`, block mutating commands. Simpler v1: no bash after `/scc`.

Allowed tools after connect:

- `read`
- `ask_user_question`
- web tools if available
- maybe non-mutating custom tools
- no `edit`
- no `write`
- no unguarded `bash`

## Side-chat context injection

Use `before_agent_start` or equivalent extension hook.

Inject instructions like:

```text
You are a read-only side-chat attached to another Pi session.

Target:
- label: <target-label>
- cwd: /repo
- session file: /path/to/session.jsonl

Rules:
- Never edit/write/commit.
- Never send messages to the main session.
- Use the target session snapshot below as context.
- This snapshot was captured when `/scc` connected; run `/scc --pick` to refresh.
```

## Session reading

- Read selected `.jsonl` once when `/scc` connects.
- Parse JSONL entries.
- Reconstruct the latest persisted branch from `parentId` links and skip off-branch entries.
- Include compact recent context, not the whole giant file.
- Minimum lazy version: last N user/assistant messages + latest compaction summary if present.
- Keep output bounded.
- Re-run `/scc --pick` or open a new side-chat to refresh the snapshot.

## Persistence

Use `pi.appendEntry("scc_state", data)` and reconstruct from current branch on `session_start`.

State shape:

```ts
{
  targetSessionFile: string,
  targetPaneId?: string,
  targetWindowId?: string,
  targetCwd?: string,
  targetName?: string,
  targetSessionId?: string,
  connectedAt: number,
  snapshotText?: string,
  snapshotAt?: number
}
```

## tmux discovery

Use `pi.exec("tmux", [...])`, not shell if possible.

Useful commands:

```bash
tmux display-message -p '#{session_name} #{window_id} #{pane_id} #{pane_tty} #{pane_current_path}'
tmux list-panes -t '<session>:<window>' -F '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'
tmux capture-pane -p -t '<pane-id>'
```

`capture-pane` is discovery-only: read the visible `chat: <name-or-full-id>` label from candidate panes in the current tmux window. Do not send keys/messages.

## Statusbar

Use Pi’s normal status API, not a custom footer:

```ts
ctx.ui.setStatus("scc", text);
```

Status states:

```text
chat: <session-name-or-full-id>
sidechat: <target-label-or-full-id>
sidechat: off
sidechat: picking target
sidechat: target missing
sidechat: blocked <tool>
```

## Target label

Do not primarily show tmux pane ids like `%34`; they are not meaningful enough.

Display priority:

1. latest `session_info.name` from selected target `.jsonl`
2. full session header `id`
3. UUID in session filename
4. tmux pane id fallback

Where names come from:

If the main Pi session ran:

```text
/name fanout-mvp
```

Pi saves this in the session file as:

```json
{"type":"session_info","name":"fanout-mvp", ...}
```

Then side-chat status should show:

```text
sidechat: fanout-mvp
```

If unnamed, fallback to the full session id:

```text
sidechat: 019f2916-...full-id
```

## Status examples

```text
chat: fanout-mvp
chat: 019f2916-...full-id
sidechat: fanout-mvp
sidechat: 019f2916-...full-id
sidechat: target missing
```

## When to update status

1. `session_start` after reconstructing `scc_state`
2. after `/scc` connects
3. after `/scc --pick`
4. before each agent turn after stat target session file
5. after a read-only guard blocks a tool

## No polling for v1

Do not add timers just to refresh status. Refresh only on extension events/commands above.

## Picker details

Pane ids may still appear in selection details:

```text
fanout-mvp    pane %34    /repo    modified 9s ago
019f2916-...  pane %37    /repo    modified 2m ago
```

## Acceptance checks

1. Two Pi panes in one tmux window: `/scc` in side pane connects to the other pane or asks for session file if ambiguous.
2. Three Pi panes in one tmux window: `/scc` asks which pane/chat to connect.
3. Same cwd in another tmux window is ignored.
4. Main session transcript is not changed.
5. After `/scc`, `edit` and `write` are unavailable/blocked.
6. `/scc --pick` reselects target.
7. Side-chat answers using read-only files plus selected main session snapshot.
8. Statusbar shows useful target label, not just tmux pane id.

## Prefer minimal implementation

- One extension file first.
- No heartbeat.
- No intercom.
- No new dependencies.
- No custom orchestrator.
- No custom footer.
- Use Node stdlib + Pi extension APIs + tmux.
