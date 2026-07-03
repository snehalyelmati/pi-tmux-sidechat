# pi-tmux-sidechat

Pi extension for `/scc` — **side-chat connect**.

Use it in tmux to open a read-only side-chat over another Pi pane’s saved session. `/scc` syncs once at connect time, stores a bounded snapshot in the side-chat session, then answers from that cached context.

## Install

```bash
pi install npm:@snehalyelmati/pi-tmux-sidechat
```

For local development from this checkout:

```bash
pi -e .
```

The package entrypoint is `index.ts`.

## tmux setup

1. Open a tmux window with your main Pi pane.
2. Load this extension in the main Pi pane too, so its status shows `scc: <session-name-or-id>`.
3. Open a second tmux pane, start Pi with this extension, and run:

```text
/scc
```

The side-chat will connect to an active Pi pane in the same tmux window.

## Commands

- `/scc` — connect, or reuse the existing connection.
- `/scc --pick` — forget current target and reselect/resync.
- `/scc --status` — show connected target.

## How it works

`/scc`:

1. detects the current tmux pane/window,
2. lists Pi panes in this tmux window only,
3. reads each candidate pane’s visible `scc: <id-or-name>` status label with read-only `tmux capture-pane`,
4. matches that label to a saved Pi session file for that pane cwd,
5. reads the selected JSONL once,
6. reconstructs the latest persisted branch via `parentId`,
7. stores a bounded snapshot in side-chat state,
8. enables read-only mode.

No intercom. No messages or keys are sent to the main Pi session.

## Snapshot sync

`/scc` syncs once. If the main session changes later, open a new side-chat or run `/scc --pick` to capture a fresh snapshot.

## Read-only enforcement

After connect:

- `edit`, `write`, and `bash` are removed from active tools,
- a `tool_call` guard blocks non-allowlisted tools,
- user `!` bash is blocked,
- `read` and available web read tools remain allowed.

## Status examples

- `scc: 019f246c` — normal Pi pane, not connected as side-chat.
- `scc: RO → fanout-mvp` — side-chat connected read-only.
- `scc: off` — explicitly cleared.
- `scc: pick target`
- `scc: target missing`

## Notes

- Candidate panes are scoped to the current tmux window, never cwd alone.
- The main pane must load the extension for active-session matching.
- Full objective and acceptance checks: [`docs/scc-objective.md`](docs/scc-objective.md).
