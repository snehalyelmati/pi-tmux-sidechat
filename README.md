# pi-tmux-sidechat

Pi extension for `/scc` — **side-chat connect**.

In a tmux window with a main Pi pane, load this extension in both Pi panes, run `/scc` in the second pane, and the second Pi session becomes a read-only side-chat over a one-time snapshot of the main Pi session’s saved JSONL session file.

## Core idea

`/scc` never talks to the main Pi process. It only:

1. detects the current tmux pane/window,
2. finds other Pi panes in the same tmux window,
3. captures each candidate pane’s visible `scc: <id-or-name>` status label read-only,
4. matches that label to the target Pi session file for that pane/cwd,
5. saves the selected session file and snapshot in side-chat state,
6. makes the side-chat read-only,
7. captures a compact snapshot of the target session at `/scc` connect time and injects that cached snapshot on side-chat turns.

## Usage

Load the repo as an extension:

```bash
pi -e /path/to/pi-tmux-sidechat
```

Or from this checkout:

```bash
pi -e .
```

The extension entrypoint is `index.ts`.

The main pane must load this extension too so it displays `scc: <current-session-name-or-id>` for discovery.

## Commands

- `/scc` — connect, or reuse an existing connection.
- `/scc --pick` — forget current target and reselect.
- `/scc --status` — show connected target.

## Snapshot sync

`/scc` syncs once when you connect. If the main session changes later, open a new side-chat or run `/scc --pick` to capture a fresh snapshot.

## Read-only mode

After connect, the side-chat must not be able to modify files.

V1 enforcement:

- disable `edit` and `write` with `pi.setActiveTools(...)`,
- add a `tool_call` guard blocking `edit` and `write`,
- prefer removing `bash` entirely after `/scc`,
- allow `read` and safe web/non-mutating tools if available.

## tmux rule

Never resolve by cwd alone. Candidate Pi panes must be in the current tmux window id. The same cwd in another tmux window is ignored. `/scc` uses read-only `tmux capture-pane` to read each candidate pane’s visible `scc:` status label and match only active sessions in this tmux window.

## Status

Use Pi status API, not a custom footer:

```ts
ctx.ui.setStatus("scc", text);
```

Example states:

- `scc: 019f246c`
- `scc: off`
- `scc: RO → fanout-mvp`
- `scc: RO → 019f246c`
- `scc: pick target`
- `scc: target missing`

## V1 scope

- One extension file first.
- No heartbeat.
- No intercom.
- No new dependencies.
- No custom orchestrator.
- No custom footer.
- Use Node stdlib + Pi extension APIs + tmux.

Full source objective and acceptance checks live in [`docs/scc-objective.md`](docs/scc-objective.md).
