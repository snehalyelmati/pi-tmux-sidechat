import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type SccState = {
	targetSessionFile: string;
	targetPaneId?: string;
	targetWindowId?: string;
	targetCwd?: string;
	targetName?: string;
	connectedAt: number;
};

type TmuxPane = {
	paneId: string;
	tty: string;
	pid: string;
	command: string;
	cwd: string;
};

type TmuxHere = {
	sessionName: string;
	windowId: string;
	paneId: string;
	tty: string;
	cwd: string;
};

type SessionMeta = {
	file: string;
	label: string;
	name?: string;
	id?: string;
	latestCompaction?: string;
	messages: Array<{ role: "user" | "assistant"; text: string }>;
};

const STATE_TYPE = "scc_state";
const SAFE_TOOLS = new Set(["read", "web_search", "fetch_content", "get_search_content"]);
const RECENT_MESSAGES = 12;
const MESSAGE_TEXT_LIMIT = 2_000;
const COMPACTION_LIMIT = 3_000;
const SNAPSHOT_LIMIT = 18_000;
const HEADER_READ_BYTES = 64 * 1024;
const TAIL_READ_BYTES = 256 * 1024;

export default function sccExtension(pi: ExtensionAPI) {
	let state: SccState | undefined;
	let explicitlyOff = false;

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		if (state) enforceReadOnly();
		await updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = restoreState(ctx);
		if (state) enforceReadOnly();
		await updateStatus(ctx);
	});

	pi.registerCommand("scc", {
		description: "Connect this pane as a read-only side-chat to another Pi tmux pane",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			if (arg === "--status") {
				ctx.ui.notify(await updateStatus(ctx), "info");
				return;
			}

			if (arg && arg !== "--pick") {
				ctx.ui.notify("Usage: /scc [--pick|--status]", "error");
				return;
			}

			if (state && arg !== "--pick") {
				enforceReadOnly();
				await updateStatus(ctx);
				ctx.ui.notify(`scc: already connected to ${state.targetName ?? state.targetSessionFile}`, "info");
				return;
			}

			if (arg === "--pick") clearState();

			ctx.ui.setStatus("scc", "scc: pick target");
			const next = await pickTarget(ctx);
			if (!next) {
				await updateStatus(ctx);
				return;
			}

			state = next;
			pi.appendEntry<SccState>(STATE_TYPE, next);
			enforceReadOnly();
			await updateStatus(ctx);
			ctx.ui.notify(`scc: connected read-only to ${next.targetName ?? next.targetSessionFile}`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state) return;

		const snapshot = await buildSnapshot(state);
		if (!snapshot) {
			ctx.ui.setStatus("scc", "scc: target missing");
			return {
				systemPrompt: `${event.systemPrompt}\n\nYou are a read-only side-chat attached to another Pi session, but the target session file is missing. Do not edit, write, commit, run bash, or message the main session.`,
			};
		}

		state = { ...state, targetName: snapshot.label };
		await updateStatus(ctx);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${snapshot.text}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state) return;
		if (SAFE_TOOLS.has(event.toolName)) return;

		ctx.ui.setStatus("scc", `scc: blocked ${event.toolName}`);
		return { block: true, reason: "scc read-only mode: only read/web tools are allowed" };
	});

	pi.on("user_bash", async () => {
		if (!state) return;
		return {
			result: {
				output: "Blocked by scc read-only mode.",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});

	function restoreState(ctx: ExtensionContext): SccState | undefined {
		let restored: SccState | undefined;
		explicitlyOff = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as (Partial<SccState> & { cleared?: boolean }) | undefined;
			if (data?.cleared === true) {
				restored = undefined;
				explicitlyOff = true;
			} else if (data && typeof data.targetSessionFile === "string") {
				restored = {
					targetSessionFile: data.targetSessionFile,
					targetPaneId: data.targetPaneId,
					targetWindowId: data.targetWindowId,
					targetCwd: data.targetCwd,
					targetName: data.targetName,
					connectedAt: typeof data.connectedAt === "number" ? data.connectedAt : Date.now(),
				};
				explicitlyOff = false;
			}
		}
		return restored;
	}

	function clearState() {
		state = undefined;
		explicitlyOff = true;
		pi.appendEntry(STATE_TYPE, { cleared: true, connectedAt: Date.now() });
	}

	function enforceReadOnly() {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([...SAFE_TOOLS].filter((tool) => available.has(tool)));
	}

	async function pickTarget(ctx: ExtensionContext): Promise<SccState | undefined> {
		const here = await getTmuxHere();
		if (!here) {
			ctx.ui.notify("scc: not inside tmux", "error");
			return;
		}

		const panes = await getPiPanes(here);
		if (panes.length === 0) {
			ctx.ui.notify("No Pi pane found", "warning");
			return;
		}

		const targets = (await Promise.all(panes.map((pane) => findActiveTargets(ctx, pane)))).flat();
		if (targets.length === 0) {
			ctx.ui.notify("No active Pi session found in this tmux window", "warning");
			return;
		}

		const target = targets.length === 1 ? targets[0] : await selectTarget(ctx, targets);
		if (!target) return;

		const meta = await readSessionMeta(target.session.path, target.pane.paneId, target.label);
		return {
			targetSessionFile: target.session.path,
			targetPaneId: target.pane.paneId,
			targetWindowId: here.windowId,
			targetCwd: target.pane.cwd,
			targetName: meta.label,
			connectedAt: Date.now(),
		};
	}

	async function getTmuxHere(): Promise<TmuxHere | undefined> {
		const result = await pi.exec("tmux", [
			"display-message",
			"-p",
			"#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_tty}\t#{pane_current_path}",
		]);
		if (result.code !== 0) return;

		const [sessionName, windowId, paneId, tty, cwd] = result.stdout.trim().split("\t");
		if (!windowId || !paneId) return;
		return { sessionName, windowId, paneId, tty, cwd };
	}

	async function getPiPanes(here: TmuxHere): Promise<TmuxPane[]> {
		const result = await pi.exec("tmux", [
			"list-panes",
			"-t",
			here.windowId,
			"-F",
			"#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}",
		]);
		if (result.code !== 0) return [];

		const panes = result.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [paneId, tty, pid, command, cwd] = line.split("\t");
				return { paneId, tty, pid, command, cwd } as TmuxPane;
			})
			.filter((pane) => pane.paneId && pane.paneId !== here.paneId);

		const processTable = await getProcessTable();
		return panes.filter((pane) => isPiPane(pane, processTable));
	}

	async function getProcessTable(): Promise<Map<string, { ppid: string; command: string }>> {
		const result = await pi.exec("ps", ["-axo", "pid=,ppid=,command="]);
		const table = new Map<string, { ppid: string; command: string }>();
		if (result.code !== 0) return table;

		for (const line of result.stdout.split("\n")) {
			const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
			if (match) table.set(match[1], { ppid: match[2], command: match[3] });
		}
		return table;
	}

	function isPiPane(pane: TmuxPane, table: Map<string, { ppid: string; command: string }>): boolean {
		if (isPiCommand(pane.command)) return true;

		const children = new Map<string, string[]>();
		for (const [pid, info] of table) {
			const list = children.get(info.ppid) ?? [];
			list.push(pid);
			children.set(info.ppid, list);
		}

		const queue = [pane.pid];
		const seen = new Set<string>();
		while (queue.length) {
			const pid = queue.shift()!;
			if (seen.has(pid)) continue;
			seen.add(pid);

			const info = table.get(pid);
			if (info && isPiCommand(info.command)) return true;
			queue.push(...(children.get(pid) ?? []));
		}
		return false;
	}

	function isPiCommand(command: string): boolean {
		const text = command.toLowerCase();
		return /(^|\s|\/)pi($|\s)/.test(text) || text.includes("pi-coding-agent");
	}

	async function findActiveTargets(ctx: ExtensionContext, pane: TmuxPane) {
		const label = await capturePaneSccLabel(pane);
		if (!label) return [];

		const currentSession = ctx.sessionManager.getSessionFile();
		const sessions = (await SessionManager.list(pane.cwd))
			.filter((session) => session.path !== currentSession)
			.filter((session) => !isSubagentSession(session))
			.filter((session) => sessionMatchesLabel(session, label));

		return sessions.map((session) => ({ pane, session, label }));
	}

	async function capturePaneSccLabel(pane: TmuxPane): Promise<string | undefined> {
		const result = await pi.exec("tmux", ["capture-pane", "-p", "-t", pane.paneId]);
		return result.code === 0 ? parseSccStatus(result.stdout) : undefined;
	}

	async function selectTarget(ctx: ExtensionContext, targets: Awaited<ReturnType<typeof findActiveTargets>>) {
		const options = targets.map((target, index) => {
			const label = target.session.name?.trim() || target.session.id.slice(0, 8) || filenameId(target.session.path) || target.label;
			return `${index + 1}. ${label}    pane ${target.pane.paneId}    ${target.pane.cwd}    modified ${age(target.session.modified.getTime())} ago`;
		});
		const choice = await ctx.ui.select("Pick active Pi session:", options);
		const index = choice ? options.indexOf(choice) : -1;
		return index >= 0 ? targets[index] : undefined;
	}

	async function updateStatus(ctx: ExtensionContext): Promise<string> {
		if (!state) {
			const text = explicitlyOff ? "scc: off" : `scc: ${currentSessionLabel(ctx)}`;
			ctx.ui.setStatus("scc", text);
			return text;
		}

		try {
			const info = await stat(state.targetSessionFile);
			const meta = await readSessionMeta(state.targetSessionFile, state.targetPaneId, state.targetName);
			state = { ...state, targetName: meta.label };
			const text = `scc: RO → ${meta.label}`;
			ctx.ui.setStatus("scc", text);
			return text;
		} catch {
			const text = "scc: target missing";
			ctx.ui.setStatus("scc", text);
			return text;
		}
	}
}

function currentSessionLabel(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().slice(0, 8);
}

function parseSccStatus(text: string): string | undefined {
	for (const line of text.split("\n").reverse()) {
		const match = stripAnsi(line).match(/\bscc:\s*([^\n]+)/);
		if (!match) continue;

		const value = match[1].split(/\s{2,}|[│|]/)[0].trim();
		if (!value || value === "off" || value === "pick target" || value === "target missing" || value.startsWith("RO")) {
			continue;
		}
		return value;
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sessionMatchesLabel(session: { id: string; name?: string }, label: string): boolean {
	return session.id.startsWith(label) || session.name?.trim() === label;
}

function isSubagentSession(session: { name?: string; firstMessage?: string }): boolean {
	return [session.name, session.firstMessage].some((value) => value?.trim().startsWith("subagent-"));
}

async function buildSnapshot(state: SccState): Promise<{ label: string; text: string } | undefined> {
	try {
		const meta = await readSessionMeta(state.targetSessionFile, state.targetPaneId, state.targetName);
		const lines = [
			"You are a read-only side-chat attached to another Pi session.",
			"",
			"Target:",
			`- label: ${meta.label}`,
			`- cwd: ${state.targetCwd ?? "unknown"}`,
			`- session file: ${state.targetSessionFile}`,
			"",
			"Rules:",
			"- Never edit/write/commit.",
			"- Never run bash.",
			"- Never send messages to the main session.",
			"- Use the target session snapshot below as context.",
			"- Re-read the session file only when refreshing target context.",
			"",
			"Target session snapshot:",
		];

		if (meta.latestCompaction) {
			lines.push("", "Latest compaction summary:", trim(meta.latestCompaction, COMPACTION_LIMIT));
		}

		lines.push("", `Recent user/assistant messages (last ${RECENT_MESSAGES}):`);
		for (const message of meta.messages) {
			lines.push(`\n[${message.role}]\n${trim(message.text, MESSAGE_TEXT_LIMIT)}`);
		}

		return { label: meta.label, text: trim(lines.join("\n"), SNAPSHOT_LIMIT) };
	} catch {
		return undefined;
	}
}

async function readSessionMeta(file: string, paneId?: string, cachedLabel?: string): Promise<SessionMeta> {
	let id: string | undefined;
	let name: string | undefined;
	let latestCompaction: string | undefined;
	const messages: SessionMeta["messages"] = [];
	const { header, tail } = await readSessionWindows(file);
	const headerEntry = parseSessionLine(header.split("\n", 1)[0] ?? "");
	if (headerEntry?.type === "session" && typeof headerEntry.id === "string") id = headerEntry.id;

	for (const line of tail.split("\n")) {
		const entry = parseSessionLine(line);
		if (!entry) continue;

		if (!id && entry.type === "session" && typeof entry.id === "string") id = entry.id;
		if (entry.type === "session_info") name = entry.name?.trim() || undefined;
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			latestCompaction = trim(entry.summary, COMPACTION_LIMIT);
		}

		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message, MESSAGE_TEXT_LIMIT);
		if (!text) continue;
		messages.push({ role, text });
		if (messages.length > RECENT_MESSAGES) messages.shift();
	}

	return { file, id, name, latestCompaction, messages, label: name || cachedLabel || id?.slice(0, 8) || filenameId(file) || paneId || "Unnamed" };
}

async function readSessionWindows(file: string): Promise<{ header: string; tail: string }> {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const header = await readWindow(handle, 0, Math.min(size, HEADER_READ_BYTES));
		const tailStart = Math.max(0, size - TAIL_READ_BYTES);
		let tail = await readWindow(handle, tailStart, size - tailStart);

		if (tailStart > 0) {
			const firstNewline = tail.indexOf("\n");
			tail = firstNewline === -1 ? "" : tail.slice(firstNewline + 1);
		}

		return { header, tail };
	} finally {
		await handle.close();
	}
}

async function readWindow(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<string> {
	if (length <= 0) return "";
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead).toString("utf8");
}

function parseSessionLine(line: string): any | undefined {
	if (!line.trim()) return;
	try {
		return JSON.parse(line);
	} catch {
		return;
	}
}

function messageText(message: any, limit: number): string {
	if (typeof message.content === "string") return trim(message.content, limit).trim();
	if (!Array.isArray(message.content)) return "";

	const parts: string[] = [];
	let length = 0;
	for (const part of message.content) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		parts.push(part.text);
		length += part.text.length + 1;
		if (length >= limit) break;
	}
	return trim(parts.join("\n"), limit).trim();
}

function filenameId(file: string): string | undefined {
	const match = basename(file).match(/_([A-Za-z0-9._-]+)\.jsonl$/);
	return match?.[1]?.slice(0, 8);
}

function age(timeMs: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function trim(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated]`;
}
