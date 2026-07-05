# pi-tmux-sidechat

Pi extension for `/scc` — **side-chat connect**.

![pi-tmux-sidechat screenshot](assets/screenshot.png)

Open a read-only side-chat over another Pi pane in the same tmux window. `/scc` reads the main Pi session from disk once, stores a bounded snapshot in the side-chat session, then answers from that cached context.

## Install

```bash
pi install npm:@snehalyelmati/pi-tmux-sidechat
```

For local development from this checkout:

```bash
pi -e .
```

## Quick start

1. In tmux, open your main Pi pane with this extension loaded.
2. Make sure the main pane shows a status like `chat: <session-name-or-id>`.
3. Open a second tmux pane in the same tmux window.
4. Start Pi with this extension loaded.
5. Run:

```text
/scc
```

Best practice: run `/scc` from a fresh side-chat session. If the side-chat already has conversation history, `/scc` will ask you to use `/scc --force` so old context is not mixed in by accident.

## Commands

- `/scc` — connect from a fresh side-chat session, or reuse the existing connection.
- `/scc --force` — connect even if this chat already has history.
- `/scc --pick` — forget current target and reselect/resync.
- `/scc --off` — disconnect and make this pane writable again.
- `/scc --status` — show connected target.

## Troubleshooting

### “No matching saved session file yet”

If `/scc` finds a Pi pane but no matching saved session, the target chat may be too fresh. Send one message in the main chat, wait for the assistant response, then try `/scc` again.

### No Pi pane found

`/scc` only looks in the current tmux window. Move the side-chat pane into the same tmux window as the main Pi pane.

### No visible `chat:` label

The main Pi pane must load this extension too. `/scc` reads the visible `chat: <session-name-or-id>` status label to match the pane to a saved session file.

## Read-only behavior

After connect:

- `edit`, `write`, and `bash` are removed from active tools,
- a `tool_call` guard blocks non-allowlisted tools,
- user `!` bash is blocked,
- `read`, available web read tools, and `ask_user_question` remain allowed.

Run `/scc --off` to disconnect and restore the tools that were active before `/scc` connected.

## Snapshot sync

`/scc` syncs once. If the main session changes later, open a new side-chat or run `/scc --pick` to capture a fresh snapshot.

## Status examples

- `chat: fanout-mvp` — normal named Pi pane.
- `chat: 019f2916-...` — normal unnamed Pi pane with full session id.
- `sidechat: fanout-mvp` — side-chat connected read-only.
- `sidechat: picking target`
- `sidechat: target missing`
- `sidechat: blocked edit`

## How it works

`/scc`:

1. detects the current tmux pane/window,
2. lists Pi panes in this tmux window only,
3. reads each candidate pane’s visible `chat: <name-or-full-id>` status label with read-only `tmux capture-pane`,
4. matches that label to a saved Pi session file for that pane cwd,
5. reads the selected JSONL once,
6. reconstructs the latest persisted branch via `parentId`,
7. stores a bounded snapshot in side-chat state,
8. enables read-only mode.

No intercom. No messages or keys are sent to the main Pi session.

## Limitations

- Candidate panes are scoped to the current tmux window, never cwd alone.
- The main pane must load the extension for active-session matching.
- The target chat needs a saved session file, which may not exist until after the first assistant response.
- The snapshot is not live; run `/scc --pick` to refresh.

## Tracking issues

Use [GitHub Issues](https://github.com/snehalyelmati/pi-tmux-sidechat/issues) for bugs and feature requests.

Suggested labels: `bug`, `enhancement`, `docs`, `question`.

## Notes

Full objective and acceptance checks: [`docs/scc-objective.md`](docs/scc-objective.md).
