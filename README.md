# pi-tmux-sidechat

Pi extension for `/scc` — **side-chat connect**.

In a tmux window with a main Pi pane, open a second pane, start `pi`, run `/scc`, and the second Pi session becomes a read-only side-chat over the main Pi session’s saved JSONL session file.

## Core idea

`/scc` never talks to the main Pi process. It only:

1. detects the current tmux pane/window,
2. finds other Pi panes in the same tmux window,
3. asks the user to choose when ambiguous,
4. selects the target Pi session file for that pane/cwd,
5. saves the selected session file in side-chat state,
6. makes the side-chat read-only,
7. injects a compact snapshot of the target session before each side-chat agent turn.

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

## Commands

- `/scc` — connect, or reuse an existing connection.
- `/scc --pick` — forget current target and reselect.
- `/scc --status` — show connected target.

## Read-only mode

After connect, the side-chat must not be able to modify files.

V1 enforcement:

- disable `edit` and `write` with `pi.setActiveTools(...)`,
- add a `tool_call` guard blocking `edit` and `write`,
- prefer removing `bash` entirely after `/scc`,
- allow `read` and safe web/non-mutating tools if available.

## tmux rule

Never resolve by cwd alone. Candidate Pi panes must be in the current tmux window id. The same cwd in another tmux window is ignored.

## Status

Use Pi status API, not a custom footer:

```ts
ctx.ui.setStatus("scc", text);
```

Example states:

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
