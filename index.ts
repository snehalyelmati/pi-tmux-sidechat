import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type SccState = {
	targetSessionFile: string;
	targetPaneId?: string;
	targetWindowId?: string;
	targetCwd?: string;
	targetName?: string;
	targetSessionId?: string;
	connectedAt: number;
	snapshotText?: string;
	snapshotAt?: number;
	priorActiveTools?: string[];
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

const STATE_TYPE = "scc_state";
const SAFE_TOOLS = new Set(["read", "web_search", "fetch_content", "get_search_content", "ask_user_question"]);
const RECENT_MESSAGES = 12;
const MESSAGE_TEXT_LIMIT = 2_000;
const COMPACTION_LIMIT = 3_000;
const SNAPSHOT_LIMIT = 18_000;

export default function sccExtension(pi: ExtensionAPI) {
	let state: SccState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		if (state) enforceReadOnly();
		await updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const priorTools = state?.priorActiveTools;
		state = restoreState(ctx);
		if (state) enforceReadOnly();
		else restoreTools(priorTools);
		await updateStatus(ctx);
	});

	pi.registerCommand("scc", {
		description: "Connect this pane as a read-only side-chat to another Pi tmux pane",
		handler: async (args, ctx) => {
			const flags = (args ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			const flagSet = new Set(flags);
			const allowedFlags = new Set(["--pick", "--status", "--off", "--force"]);

			if (flags.some((flag) => !allowedFlags.has(flag)) || hasConflictingModeFlags(flagSet, flags.length)) {
				ctx.ui.notify("Usage: /scc [--pick] [--force] [--off|--status]", "error");
				return;
			}

			if (flagSet.has("--status")) {
				ctx.ui.notify(await updateStatus(ctx), "info");
				return;
			}

			if (flagSet.has("--off")) {
				const tools = state?.priorActiveTools;
				clearState();
				restoreTools(tools);
				ctx.ui.notify(await updateStatus(ctx), "info");
				return;
			}

			const pick = flagSet.has("--pick");
			const force = flagSet.has("--force");
			const previousState = state;
			const priorActiveTools = previousState?.priorActiveTools;
			if (state && !pick) {
				enforceReadOnly();
				await updateStatus(ctx);
				ctx.ui.notify(`sidechat: already connected to ${targetLabel(state)}`, "info");
				return;
			}

			if (!state && hasChatHistory(ctx) && !force) {
				ctx.ui.notify(
					"/scc works best from a fresh side-chat session. This chat already has history; use /scc --force to connect anyway.",
					"warning",
				);
				return;
			}

			setSidechatStatus(ctx, "sidechat: picking target");
			const next = await pickTarget(ctx);
			if (!next) {
				state = previousState;
				if (state) enforceReadOnly();
				await updateStatus(ctx);
				return;
			}

			if (pick) clearState();
			next.priorActiveTools = priorActiveTools ?? pi.getActiveTools();
			state = next;
			pi.appendEntry<SccState>(STATE_TYPE, next);
			enforceReadOnly();
			await updateStatus(ctx);
			ctx.ui.notify(`sidechat: connected to ${targetLabel(next)}`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state) return;

		if (!state.snapshotText) {
			setSidechatStatus(ctx, "sidechat: target missing");
			return {
				systemPrompt: `${event.systemPrompt}\n\nYou are a read-only side-chat attached to another Pi session, but no target snapshot is available. Do not edit, write, commit, run bash, or message the main session.`,
			};
		}

		await updateStatus(ctx);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${state.snapshotText}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state) return;
		if (SAFE_TOOLS.has(event.toolName)) return;

		setSidechatStatus(ctx, `sidechat: blocked ${event.toolName}`);
		return { block: true, reason: "scc read-only mode: only read/web/question tools are allowed" };
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
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as (Partial<SccState> & { cleared?: boolean }) | undefined;
			if (data?.cleared === true) {
				restored = undefined;
			} else if (data && typeof data.targetSessionFile === "string") {
				restored = {
					targetSessionFile: data.targetSessionFile,
					targetPaneId: data.targetPaneId,
					targetWindowId: data.targetWindowId,
					targetCwd: data.targetCwd,
					targetName: data.targetName,
					targetSessionId: data.targetSessionId,
					connectedAt: typeof data.connectedAt === "number" ? data.connectedAt : Date.now(),
					snapshotText: typeof data.snapshotText === "string" ? data.snapshotText : undefined,
					snapshotAt: typeof data.snapshotAt === "number" ? data.snapshotAt : undefined,
					priorActiveTools: Array.isArray(data.priorActiveTools)
						? data.priorActiveTools.filter((tool): tool is string => typeof tool === "string")
						: (restored?.priorActiveTools ?? state?.priorActiveTools),
				};
			}
		}
		return restored;
	}

	function clearState() {
		state = undefined;
		pi.appendEntry(STATE_TYPE, { cleared: true, connectedAt: Date.now() });
	}

	function enforceReadOnly() {
		if (state && !state.priorActiveTools) state.priorActiveTools = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([...SAFE_TOOLS].filter((tool) => available.has(tool)));
	}

	function restoreTools(tools = state?.priorActiveTools) {
		if (tools) pi.setActiveTools(tools);
	}

	function hasConflictingModeFlags(flags: Set<string>, count: number): boolean {
		return count > 1 && (flags.has("--status") || flags.has("--off"));
	}

	function hasChatHistory(ctx: ExtensionContext): boolean {
		return ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role));
	}

	async function pickTarget(ctx: ExtensionContext): Promise<SccState | undefined> {
		const here = await getTmuxHere();
		if (!here) {
			ctx.ui.notify("sidechat: not inside tmux", "error");
			return;
		}

		const panes = await getPiPanes(here);
		if (panes.length === 0) {
			ctx.ui.notify("sidechat: no Pi pane found", "warning");
			return;
		}

		const discoveries = await Promise.all(panes.map((pane) => findActiveTargets(ctx, pane)));
		const targets = discoveries.flatMap((discovery) => discovery.targets);
		if (targets.length === 0) {
			const labeled = discoveries.filter((discovery) => discovery.label);
			if (labeled.length === 0) {
				ctx.ui.notify("sidechat: found Pi pane(s), but no visible chat: status label", "warning");
				return;
			}

			ctx.ui.notify(
				`sidechat: found Pi chat(s), but no matching saved session file yet:\n${labeled
					.map((discovery) => `pane ${discovery.pane.paneId}: chat ${discovery.label}`)
					.join("\n")}\nIf the target chat is fresh, send one message in it and try /scc again.`,
				"warning",
			);
			return;
		}

		const target = targets.length === 1 ? targets[0] : await selectTarget(ctx, targets);
		if (!target) return;

		let snapshot: Awaited<ReturnType<typeof buildSnapshotFromFile>>;
		try {
			snapshot = await buildSnapshotFromFile(target.session.path, target.pane.cwd, target.pane.paneId, target.label);
		} catch (error) {
			ctx.ui.notify(`sidechat: target session unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			setSidechatStatus(ctx, "sidechat: target missing");
			return;
		}

		return {
			targetSessionFile: target.session.path,
			targetPaneId: target.pane.paneId,
			targetWindowId: here.windowId,
			targetCwd: target.pane.cwd,
			targetName: snapshot.name,
			targetSessionId: snapshot.sessionId,
			connectedAt: Date.now(),
			snapshotText: snapshot.text,
			snapshotAt: Date.now(),
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
		const label = await capturePaneChatLabel(pane);
		if (!label) return { pane, targets: [] };

		const currentSession = ctx.sessionManager.getSessionFile();
		const sessions = (await SessionManager.list(pane.cwd))
			.filter((session) => session.path !== currentSession)
			.filter((session) => !isSubagentSession(session))
			.filter((session) => sessionMatchesLabel(session, label));

		return { pane, label, targets: sessions.map((session) => ({ pane, session, label })) };
	}

	async function capturePaneChatLabel(pane: TmuxPane): Promise<string | undefined> {
		const result = await pi.exec("tmux", ["capture-pane", "-p", "-t", pane.paneId]);
		return result.code === 0 ? parseChatStatus(result.stdout) : undefined;
	}

	async function selectTarget(
		ctx: ExtensionContext,
		targets: Awaited<ReturnType<typeof findActiveTargets>>["targets"],
	) {
		const options = targets.map((target, index) => {
			const label = target.session.name?.trim() || target.session.id;
			return `${index + 1}. ${label}    pane ${target.pane.paneId}    ${target.pane.cwd}    modified ${age(target.session.modified.getTime())} ago`;
		});
		const choice = await ctx.ui.select("Pick active Pi session:", options);
		const index = choice ? options.indexOf(choice) : -1;
		return index >= 0 ? targets[index] : undefined;
	}

	async function updateStatus(ctx: ExtensionContext): Promise<string> {
		if (!state) {
			const text = `chat: ${currentSessionLabel(ctx)}`;
			setSidechatStatus(ctx, text);
			return text;
		}

		try {
			await stat(state.targetSessionFile);
			const text = `sidechat: ${targetLabel(state)}`;
			setSidechatStatus(ctx, text);
			return text;
		} catch {
			const text = "sidechat: target missing";
			setSidechatStatus(ctx, text);
			return text;
		}
	}
}

function setSidechatStatus(ctx: ExtensionContext, text: string) {
	ctx.ui.setStatus("scc", ctx.ui.theme.fg("muted", text));
}

function currentSessionLabel(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId();
}

function targetLabel(state: SccState): string {
	return state.targetName ?? state.targetSessionId ?? filenameId(state.targetSessionFile) ?? state.targetPaneId ?? "Unnamed";
}

function parseChatStatus(text: string): string | undefined {
	for (const line of text.split("\n").reverse()) {
		const match = stripAnsi(line).match(/\bchat:\s*([^\n]+)/);
		if (!match) continue;
		const value = match[1].split(/\s{2,}|[│|]/)[0].trim();
		if (value) return value;
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sessionMatchesLabel(session: { id: string; name?: string }, label: string): boolean {
	return session.id === label || session.name?.trim() === label;
}

function isSubagentSession(session: { name?: string; firstMessage?: string }): boolean {
	return [session.name, session.firstMessage].some((value) => value?.trim().startsWith("subagent-"));
}

async function buildSnapshotFromFile(
	file: string,
	cwd: string,
	paneId?: string,
	cachedLabel?: string,
): Promise<{ label: string; name?: string; sessionId?: string; text: string }> {
	const raw = await readFile(file, "utf8");
	let sessionId: string | undefined;
	let leafId: string | undefined;
	const byId = new Map<string, any>();

	for (const line of raw.split("\n")) {
		const entry = parseSessionLine(line);
		if (!entry) continue;
		if (entry.type === "session" && typeof entry.id === "string") sessionId = entry.id;
		if (entry.type !== "session" && typeof entry.id === "string") {
			byId.set(entry.id, entry);
			leafId = entry.id;
		}
	}

	const branch: any[] = [];
	const seen = new Set<string>();
	for (let id = leafId; id && !seen.has(id); ) {
		seen.add(id);
		const entry = byId.get(id);
		if (!entry) break;
		branch.push(entry);
		id = typeof entry.parentId === "string" ? entry.parentId : undefined;
	}
	branch.reverse();

	let name: string | undefined;
	let latestCompaction: string | undefined;
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];

	for (const entry of branch) {
		if (entry.type === "session_info") name = entry.name?.trim() || undefined;
		if (entry.type === "compaction" && typeof entry.summary === "string") latestCompaction = trim(entry.summary, COMPACTION_LIMIT);
		if (entry.type !== "message") continue;

		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message, MESSAGE_TEXT_LIMIT);
		if (!text) continue;
		messages.push({ role, text });
		if (messages.length > RECENT_MESSAGES) messages.shift();
	}

	const label = name || cachedLabel || sessionId || filenameId(file) || paneId || "Unnamed";
	const lines = [
		"You are a read-only side-chat attached to another Pi session.",
		"",
		"Target:",
		`- label: ${label}`,
		`- cwd: ${cwd}`,
		`- session file: ${file}`,
		`- snapshot captured: ${new Date().toISOString()}`,
		"",
		"Rules:",
		"- Never edit/write/commit.",
		"- Never run bash.",
		"- Never send messages to the main session.",
		"- Use the target session snapshot below as context.",
		"- This snapshot was captured when /scc connected; run /scc --pick to refresh.",
		"",
		"Target session snapshot:",
	];

	if (latestCompaction) lines.push("", "Latest compaction summary:", latestCompaction);

	lines.push("", `Recent user/assistant messages on latest persisted branch (last ${RECENT_MESSAGES}):`);
	for (const message of messages) lines.push(`\n[${message.role}]\n${message.text}`);

	return { label, name, sessionId, text: trim(lines.join("\n"), SNAPSHOT_LIMIT) };
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
	return match?.[1];
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
