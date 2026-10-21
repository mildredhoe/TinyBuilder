/**
 * side-panel — right-hand FILES / PREVIEW pane for little-coder.
 *
 * The chat stays on the left, narrow. The right side shows either the project
 * tree or the source of the file the agent last touched.
 *
 * Commands:
 *   /files    show the project tree
 *   /preview  show the last written file
 *   /panel    hide or show the panel
 *   /serve    start a local server and print the preview URL
 *   /stop     stop the local server
 */

import { readdirSync, statSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const nodeRequire = createRequire(import.meta.url);

function npmRoot(): string {
	try {
		return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch {
		return "/opt/homebrew/lib/node_modules";
	}
}
// Pi's own measurement utilities, so every line we emit matches what the TUI
// validates against. Resolved from the installed little-coder.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");

let visibleWidth: (s: string) => number = (s) => stripAnsi(s).length;
let wrapTextWithAnsi: (s: string, w: number) => string[] = (s, w) => {
	const plain = stripAnsi(s);
	if (plain.length <= w) return [s];
	const out: string[] = [];
	for (let i = 0; i < plain.length; i += w) out.push(plain.slice(i, i + w));
	return out;
};

let truncateToWidth: (s: string, w: number, ell?: string, pad?: boolean) => string = (s, w, _e, pad) => {
	const plain = stripAnsi(s);
	if (plain.length > w) return plain.slice(0, w);
	return pad ? plain + " ".repeat(w - plain.length) : plain;
};

function loadTuiUtils(): void {
	const candidates = [
		"/opt/homebrew/lib/node_modules/little-coder/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/utils.js",
		join(npmRoot(), "little-coder/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/utils.js"),
	];
	for (const path of candidates) {
		try {
			const utils = nodeRequire(path);
			if (typeof utils.visibleWidth === "function") {
				visibleWidth = utils.visibleWidth;
				truncateToWidth = utils.truncateToWidth;
				if (typeof utils.wrapTextWithAnsi === "function") {
					wrapTextWithAnsi = utils.wrapTextWithAnsi;
				}
				return;
			}
		} catch {
			/* try next */
		}
	}
}

loadTuiUtils();

const SKIP = new Set([
	"node_modules", ".git", ".pi", "dist", "build", ".cache", "target",
	".next", ".venv", "venv", "__pycache__", ".DS_Store", "coverage",
]);

const MAX_FILES = 300;
const SIDE_WIDTH = 110;

function terminalRows(): number {
	return Number(process.stdout.rows) || 24;
}

type Tab = "files" | "preview" | "memory";

const MEM_DB = join(process.env.HOME ?? "", ".pi/agent/pi-hermes-memory/sessions.db");

type MemEntry = {
	id: number;
	target: string;
	category: string;
	content: string;
	created: string;
	hits: number;
};

const state = {
	visible: true,
	tab: "files" as Tab,
	lastFile: "",
	root: process.cwd(),
	server: null as ChildProcess | null,
	serveUrl: "",
	panelLeft: 0,
	panelTop: 0,
	mouseOn: false,
	files: [] as string[],
	selected: 0,
	fileOffset: 0,
	memories: [] as MemEntry[],
	memSelected: 0,
	memOffset: 0,
	chatScroll: 0,
	previewScroll: 0,
	lastPreviewClick: 0,
	editing: false,
	editLines: [] as string[],
	editCursor: { line: 0, col: 0 },
	suspended: false,
	chatHistory: [] as string[],
	chatBanner: [] as string[],
	chatPin: [] as string[],
	memLoadedAt: 0,
};

// ── ANSI helpers ────────────────────────────────────────────────────────
// Use Pi's own measurement so every line we emit matches what it validates.
const width = (s: string) => visibleWidth(s);

function clip(s: string, w: number): string {
	return truncateToWidth(s, w, "", false);
}

function fit(s: string, w: number): string {
	return truncateToWidth(s, w, "", true);
}

// ── filesystem ──────────────────────────────────────────────────────────
function safeStat(p: string): ReturnType<typeof statSync> | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

function walk(dir: string, base: string, out: string[], depth = 0): void {
	if (out.length >= MAX_FILES || depth > 4) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	entries.sort((a, b) => {
		const ad = safeStat(join(dir, a))?.isDirectory() ? 0 : 1;
		const bd = safeStat(join(dir, b))?.isDirectory() ? 0 : 1;
		return ad - bd || a.localeCompare(b);
	});
	for (const name of entries) {
		if (out.length >= MAX_FILES) return;
		if (SKIP.has(name) || name.startsWith(".")) continue;
		const full = join(dir, name);
		const st = safeStat(full);
		if (!st) continue;
		const rel = relative(base, full);
		if (st.isDirectory()) {
			out.push(`${rel}/`);
			walk(full, base, out, depth + 1);
		} else {
			out.push(rel);
		}
	}
}

/** Read memories from pi-hermes-memory's SQLite store. */
function loadMemories(): void {
	// Cheap guard: re-read at most once per second.
	const now = Date.now();
	if (now - state.memLoadedAt < 1000 && state.memories.length > 0) return;
	state.memLoadedAt = now;

	if (!existsSync(MEM_DB)) {
		state.memories = [];
		return;
	}

	try {
		const raw = execFileSync(
			"sqlite3",
			[
				"-json",
				MEM_DB,
				"SELECT id, target, COALESCE(category,''), content, created, hit_count AS hits FROM memories ORDER BY created DESC, id DESC LIMIT 200;",
			],
			{ encoding: "utf8", timeout: 2000 },
		);
		const rows = raw.trim() ? JSON.parse(raw) : [];
		state.memories = rows as MemEntry[];
	} catch {
		state.memories = [];
	}
}

function panelLines(height: number, panelW: number): string[] {
	const lines: string[] = [];

	const tabLabel = (id: Tab, label: string) =>
		state.tab === id ? `\x1b[1;36m ${label} \x1b[0m` : `\x1b[2m ${label.toLowerCase()} \x1b[0m`;
	lines.push(`${tabLabel("files", "FILES")}${tabLabel("preview", "PREVIEW")}${tabLabel("memory", "MEMORY")}`);
	lines.push("\x1b[2m" + "─".repeat(Math.max(1, panelW - 2)) + "\x1b[0m");

	const body: string[] = [];
	const bodyRows = Math.max(1, height - lines.length);

	if (state.editing) {
		// Editable buffer with an action bar on top.
		body.push(`\x1b[7m Guardar \x1b[27m  \x1b[2mCancelar\x1b[0m   \x1b[2m${state.lastFile}\x1b[0m`);
		body.push("\x1b[2m" + "─".repeat(Math.max(1, panelW - 2)) + "\x1b[0m");

		const rows = Math.max(1, height - lines.length - 1);
		const { line, col } = state.editCursor;
		const start = Math.max(
			0,
			Math.min(line - Math.floor(rows / 2), Math.max(0, state.editLines.length - rows)),
		);

		for (let i = 0; i < rows; i++) {
			const idx = start + i;
			const text = state.editLines[idx] ?? "";
			if (idx === line) {
				const before = text.slice(0, col);
				const at = text[col] ?? " ";
				const after = text.slice(col + 1);
				body.push(`${String(idx + 1).padStart(3)} ${before}\x1b[7m${at}\x1b[27m${after}`);
			} else {
				body.push(`\x1b[2m${String(idx + 1).padStart(3)}\x1b[0m ${text}`);
			}
		}
	} else if (state.tab === "files") {
		// Rebuild the list each render so new files show up immediately.
		state.files = [];
		walk(state.root, state.root, state.files);

		if (state.files.length === 0) {
			body.push("\x1b[2m(sin archivos)\x1b[0m");
		} else {
			// Keep the selection inside bounds.
			if (state.selected >= state.files.length) state.selected = state.files.length - 1;
			if (state.selected < 0) state.selected = 0;

			// Scroll so the selection stays visible.
			if (state.selected < state.fileOffset) state.fileOffset = state.selected;
			if (state.selected >= state.fileOffset + bodyRows) {
				state.fileOffset = state.selected - bodyRows + 1;
			}

			const slice = state.files.slice(state.fileOffset, state.fileOffset + bodyRows);
			slice.forEach((f, i) => {
				const idx = state.fileOffset + i;
				const isDir = f.endsWith("/");
				const isSelected = idx === state.selected;
				const isOpen = f === state.lastFile;

				// Selected row: a cyan arrow in the gutter and a bold name.
				// Open file: a small yellow dot when it is not the cursor row.
				const arrow = isSelected ? "\x1b[1;36m❯\x1b[0m" : " ";
				const dot = isOpen && !isSelected ? "\x1b[1;33m•\x1b[0m" : " ";
				const label = isDir ? `\x1b[34m${f}\x1b[0m` : f;
				const name = isSelected ? `\x1b[1m${label}\x1b[22m` : label;
				body.push(`${arrow}${dot} ${name}`);
			});
		}
	} else if (state.tab === "memory") {
		loadMemories();

		if (state.memories.length === 0) {
			body.push("\x1b[2m(sin memoria guardada todavía)\x1b[0m");
			body.push("");
			body.push("\x1b[2mEl agente guarda aquí preferencias, decisiones y\x1b[0m");
			body.push("\x1b[2mcorrecciones del proyecto.\x1b[0m");
		} else {
			if (state.memSelected >= state.memories.length) state.memSelected = state.memories.length - 1;
			if (state.memSelected < 0) state.memSelected = 0;

			const rowH = 3; // one entry spans title + content + spacer
			const perPage = Math.max(1, Math.floor(bodyRows / rowH));

			if (state.memSelected < state.memOffset) state.memOffset = state.memSelected;
			if (state.memSelected >= state.memOffset + perPage) {
				state.memOffset = state.memSelected - perPage + 1;
			}

			const icons: Record<string, string> = {
				failure: "\x1b[31m✖\x1b[0m",
				correction: "\x1b[33m✎\x1b[0m",
				insight: "\x1b[35m✦\x1b[0m",
				preference: "\x1b[32m♥\x1b[0m",
				convention: "\x1b[34m◈\x1b[0m",
				"tool-quirk": "\x1b[36m⚙\x1b[0m",
			};

			const slice = state.memories.slice(state.memOffset, state.memOffset + perPage);
			slice.forEach((m, i) => {
				const idx = state.memOffset + i;
				const isSel = idx === state.memSelected;
				const icon = icons[m.category] ?? "\x1b[2m·\x1b[0m";
				const head = m.category ? `${icon} \x1b[2m${m.category}\x1b[0m` : `${icon} \x1b[2mmemory\x1b[0m`;
				const marker = isSel ? "\x1b[1;36m❯\x1b[0m" : " ";
				const text = m.content.length > panelW - 6 ? `${m.content.slice(0, panelW - 9)}…` : m.content;
				const styled = isSel ? `\x1b[1m${text}\x1b[22m` : text;

				body.push(`${marker} ${head} \x1b[2m${m.created}\x1b[0m`);
				body.push(`  ${styled}`);
				body.push("");
			});
		}
	} else if (!state.lastFile) {
		body.push("\x1b[2m(selecciona un archivo en FILES)\x1b[0m");
	} else {
		body.push(`\x1b[1m${state.lastFile}\x1b[0m  \x1b[2m(doble click para editar)\x1b[0m`);
		body.push("\x1b[2m" + "─".repeat(Math.max(1, panelW - 2)) + "\x1b[0m");

		const abs = join(state.root, state.lastFile);
		let text = "";
		try {
			text = readFileSync(abs, "utf8");
		} catch {
			body.push("\x1b[2m(archivo eliminado)\x1b[0m");
		}
		if (text) {
			const rows = Math.max(1, height - lines.length - 1);
			const all = text.split("\n");
			const maxScroll = Math.max(0, all.length - rows);
			if (state.previewScroll > maxScroll) state.previewScroll = maxScroll;
			if (state.previewScroll < 0) state.previewScroll = 0;

			all
				.slice(state.previewScroll, state.previewScroll + rows)
				.forEach((l, i) => {
					const n = state.previewScroll + i + 1;
					body.push(`\x1b[2m${String(n).padStart(3)}\x1b[0m ${l}`);
				});
		}
	}

	const room = height - lines.length;
	lines.push(...body.slice(0, Math.max(0, room)));
	while (lines.length < height) lines.push("");
	return lines;
}

function stopServer(): void {
	state.server?.kill("SIGTERM");
	state.server = null;
	state.serveUrl = "";
}

export default function (pi: ExtensionAPI) {
	let patched = false;
	let originalRender: ((w: number) => string[]) | null = null;
	let tuiRef: any = null;

/** Load the previewed file into the inline editor buffer. */
function startEdit(ctx: any): void {
	if (!state.lastFile) {
		ctx?.ui?.notify?.("Selecciona un archivo primero", "warning");
		return;
	}
	const abs = join(state.root, state.lastFile);
	if (!existsSync(abs)) {
		ctx?.ui?.notify?.(`No existe: ${state.lastFile}`, "error");
		return;
	}
	let text = "";
	try {
		text = readFileSync(abs, "utf8");
	} catch {
		ctx?.ui?.notify?.("No se pudo leer el archivo", "error");
		return;
	}
	state.editLines = text.split("\n");
	state.editCursor = { line: 0, col: 0 };
	state.editing = true;
	tuiRef?.requestRender?.();
}

function saveEdit(ctx: any): void {
	const abs = join(state.root, state.lastFile);
	try {
		writeFileSync(abs, state.editLines.join("\n"), "utf8");
		ctx?.ui?.notify?.(`Guardado: ${state.lastFile}`, "info");
	} catch {
		ctx?.ui?.notify?.("No se pudo guardar", "error");
		return;
	}
	state.editing = false;
	tuiRef?.requestRender?.();
}

function cancelEdit(ctx: any): void {
	state.editing = false;
	tuiRef?.requestRender?.();
	ctx?.ui?.notify?.("Edición cancelada", "info");
}


	function patch(tui: any) {
		if (patched) return;
		tuiRef = tui;
		originalRender = tui.render.bind(tui);
		patched = true;

		tui.render = (w: number): string[] => {
			// While $EDITOR owns the terminal we must not touch its output.
			if (state.suspended) return originalRender!(w);

			// leftW + 1 divider + rightW must equal exactly w.
			const rightW = Math.min(SIDE_WIDTH, Math.max(30, Math.floor(w * 0.62)));
			const leftW = Math.max(1, w - rightW - 1);

			// Render the chat at its real column width so Pi wraps text to the
			// left pane instead of the full terminal.
			const left = originalRender!(state.visible ? leftW : w);
			if (!state.visible) return left;

			const viewH = Math.max(6, terminalRows());

			// The editor block is: rule / input / rule / status / footer.
			// Find the editor line via Pi's cursor marker, then walk back over
			// the rule above it. Everything from there down stays pinned to the
			// bottom; blanks go in before it so the header keeps the top.
			const MARKER = "\u001B_pi:c\u0007";
			let pinnedFrom = left.length;
			for (let i = 0; i < left.length; i++) {
				if (left[i].includes(MARKER)) {
					pinnedFrom = Math.max(0, i - 1);
					break;
				}
			}
			if (pinnedFrom >= left.length) pinnedFrom = Math.max(0, left.length - 5);

			// Keep Pi's order, emit exactly one screenful, and never scroll the
			// chrome away. The banner at the top (first non-blank lines up to the
			// first blank) stays pinned; only the middle history is trimmed.
			const pin = left.slice(Math.min(pinnedFrom, left.length));

			// Pi already wrapped to leftW when we rendered at that width, so no
			// re-wrapping is needed here. Just take the lines as they are.
			const headAll = left.slice(0, Math.min(pinnedFrom, left.length));

			// Split the head into a pinned banner and a scrollable history.
			let bannerEnd = 0;
			for (let i = 0; i < headAll.length; i++) {
				if (stripAnsi(headAll[i]).trim() === "") {
					bannerEnd = i;
					break;
				}
			}
			if (bannerEnd === 0) bannerEnd = Math.min(headAll.length, 3);

			const banner = headAll.slice(0, bannerEnd);
			const history = headAll.slice(bannerEnd);

			// Remember pieces so the wheel handler can scroll the history.
			state.chatBanner = banner;
			state.chatHistory = history;
			state.chatPin = pin;

			const roomForHead = Math.max(0, viewH - pin.length);
			const roomForHistory = Math.max(0, roomForHead - banner.length);
			const maxScroll = Math.max(0, history.length - roomForHistory);
			if (state.chatScroll > maxScroll) state.chatScroll = maxScroll;
			if (state.chatScroll < 0) state.chatScroll = 0;

			const start = Math.max(0, history.length - roomForHistory - state.chatScroll);
			const histTrimmed = history.slice(start, start + roomForHistory);
			const slack = Math.max(0, roomForHistory - histTrimmed.length);

			let chat = [...banner, ...histTrimmed, ...Array(slack).fill(""), ...pin];
			if (chat.length > viewH) chat = chat.slice(0, viewH);
			while (chat.length < viewH) chat.push("");

			state.panelLeft = leftW;
			state.panelTop = 0;
			const H = viewH;
			const right = panelLines(H, rightW);

			const out: string[] = [];
			for (let i = 0; i < H; i++) {
				const raw = chat[i] ?? "";
				// Pad without re-encoding: only strip when it is actually wider.
				const w0 = visibleWidth(raw);
				const line = w0 > leftW ? truncateToWidth(raw, leftW, "", false) : raw + " ".repeat(leftW - w0);
				out.push(`${line}│${clip(right[i] ?? "", rightW)}`);

			}
			return out;
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		state.root = ctx.cwd;

		for (const candidate of ["index.html", "public/index.html", "src/index.html"]) {
			if (existsSync(join(ctx.cwd, candidate))) {
				state.lastFile = candidate;
				break;
			}
		}

		ctx.ui.setWidget(
			"side-panel",
			(tui: any) => {
				patch(tui);
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						// Hand the terminal back untouched when this widget goes away.
						if (patched && originalRender && tuiRef) {
							try {
								tuiRef.render = originalRender;
							} catch {
								/* ignore */
							}
							patched = false;
							originalRender = null;
						}
						if (state.mouseOn) {
							try {
								process.stdout.write("\x1b[?1006l\x1b[?1003l");
							} catch {
								/* ignore */
							}
							state.mouseOn = false;
						}
					},
				};
			},
			{ placement: "belowEditor" },
		);

		ctx.ui.setStatus("side-panel", `panel ${state.tab}`);

		// Enable SGR mouse reporting so clicking the tabs works.
		try {
			process.stdout.write("\x1b[?1003h\x1b[?1006h");
			state.mouseOn = true;
		} catch {
			/* ignore */
		}

		// Click on the tab bar (row 1 of the panel).
		ctx.ui.onTerminalInput((data: string) => {
			// Mouse events must reach the click handler below, even while editing,
			// so the Guardar / Cancelar buttons work.
			const isMouse = /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);

			// Inline editor: capture keys while editing.
			if (state.editing && !isMouse) {
				const { line, col } = state.editCursor;
				const cur = state.editLines[line] ?? "";

				if (data === "\x1b") {
					cancelEdit(ctx);
					return { consume: true };
				}
				if (data === "\x13") {
					saveEdit(ctx);
					return { consume: true };
				}
				if (data === "\x1b[A") {
					state.editCursor.line = Math.max(0, line - 1);
					state.editCursor.col = Math.min(col, (state.editLines[state.editCursor.line] ?? "").length);
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				if (data === "\x1b[B") {
					state.editCursor.line = Math.min(state.editLines.length - 1, line + 1);
					state.editCursor.col = Math.min(col, (state.editLines[state.editCursor.line] ?? "").length);
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				if (data === "\x1b[C") {
					state.editCursor.col = Math.min(cur.length, col + 1);
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				if (data === "\x1b[D") {
					state.editCursor.col = Math.max(0, col - 1);
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				if (data === "\r" || data === "\n") {
					state.editLines.splice(line, 1, cur.slice(0, col), cur.slice(col));
					state.editCursor = { line: line + 1, col: 0 };
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				if (data === "\x7f") {
					if (col > 0) {
						state.editLines[line] = cur.slice(0, col - 1) + cur.slice(col);
						state.editCursor.col = col - 1;
					} else if (line > 0) {
						const prev = state.editLines[line - 1] ?? "";
						state.editLines.splice(line - 1, 2, prev + cur);
						state.editCursor = { line: line - 1, col: prev.length };
					}
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				// Printable character.
				if (data.length >= 1 && data >= " " && !data.startsWith("\x1b")) {
					state.editLines[line] = cur.slice(0, col) + data + cur.slice(col);
					state.editCursor.col = col + data.length;
					tuiRef?.requestRender?.();
					return { consume: true };
				}
				return { consume: true };
			}

			// Only mouse events are intercepted. Keys belong to the editor.

			const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
			if (!m) return undefined;
			if (m[4] !== "M") return undefined; // only presses

			const b = Number(m[1]);
			const x = Number(m[2]);
			const y = Number(m[3]);

			// Wheel: button 64, bit 0 = up, bit 1 = down. Scroll the pane under
			// the pointer — the panel on the right, the chat on the left.
			if (b & 64) {
				const up = (b & 3) === 0;
				const onPanel = x - 1 >= state.panelLeft;

				if (onPanel) {
					if (state.tab === "preview") {
						state.previewScroll = Math.max(0, state.previewScroll + (up ? -3 : 3));
					} else if (state.tab === "files" && state.files.length > 0) {
						state.selected = Math.max(
							0,
							Math.min(state.files.length - 1, state.selected + (up ? -1 : 1)),
						);
					} else if (state.tab === "memory" && state.memories.length > 0) {
						state.memSelected = Math.max(
							0,
							Math.min(state.memories.length - 1, state.memSelected + (up ? -1 : 1)),
						);
					}
				} else {
					state.chatScroll = Math.max(0, state.chatScroll + (up ? 3 : -3));
				}

				tuiRef?.requestRender?.();
				return { consume: true };
			}

			if (b & 32) return undefined; // mouse motion
			if ((b & 3) !== 0) return undefined; // left button only

			// Panel starts at column 0 of its own area, row 0 of the screen.
			const col = x - 1 - state.panelLeft;
			// Panel is anchored to the bottom viewport; translate the screen row
			// into a panel-relative row.
			const row = y - 1 - state.panelTop;

			if (col < 0) return undefined;

			// Tab bar (rows 0-1): " FILES " " PREVIEW " " MEMORY "
			if (row >= 0 && row <= 1) {
				if (col >= 0 && col <= 6) state.tab = "files";
				else if (col >= 7 && col <= 16) state.tab = "preview";
				else if (col >= 17 && col <= 25) state.tab = "memory";
				else return undefined;
				tuiRef?.requestRender?.();
				ctx.ui.setStatus("side-panel", `panel ${state.tab}`);
				return { consume: true };
			}

			// Inline editor action bar: " Guardar " at cols 1-8, "Cancelar" 10-17.
			// Action bar: " Guardar " = cols 1-7, "Cancelar" = cols 11-18.
			if (state.editing && row === 2) {
				if (col >= 0 && col <= 8) {
					saveEdit(ctx);
					return { consume: true };
				}
				if (col >= 9 && col <= 19) {
					cancelEdit(ctx);
					return { consume: true };
				}
				return { consume: false };
			}

			// PREVIEW: double-click anywhere in the file opens the inline editor.
			if (state.tab === "preview" && row >= 2 && state.lastFile) {
				const now = Date.now();
				if (now - state.lastPreviewClick < 400) {
					state.lastPreviewClick = 0;
					startEdit(ctx);
					return { consume: true };
				}
				state.lastPreviewClick = now;
				return { consume: true };
			}

			// File list: body starts after the tab bar and the rule.
			if (state.tab === "files" && row >= 2) {
				const idx = state.fileOffset + (row - 2);
				if (idx < 0 || idx >= state.files.length) return undefined;
				state.selected = idx;

				const name = state.files[idx];
				// Folders just move the cursor; files become the preview target.
				if (!name.endsWith("/")) {
					state.lastFile = name;
				}
				tuiRef?.requestRender?.();
				return { consume: true };
			}

			return undefined;
		});
	});

	pi.on("session_shutdown", async () => {
		if (state.mouseOn) {
			try {
				process.stdout.write("\x1b[?1006l\x1b[?1003l");
			} catch {
				/* ignore */
			}
			state.mouseOn = false;
		}
		stopServer();
	});

	pi.on("tool_result", async (event: any) => {
		const name = String(event?.toolName ?? "");
		if (name !== "write_code" && name !== "edit_code" && name !== "write" && name !== "edit") {
			return;
		}

		// write_code carries the path in details; the built-ins use input.
		const path =
			event?.details?.path ??
			event?.input?.path ??
			event?.input?.file_path ??
			"";

		// Whatever happened, the tree may have changed.
		tuiRef?.requestRender?.();

		if (typeof path === "string" && path) {
			state.lastFile = relative(state.root, join(state.root, path));
			state.tab = "preview";
			tuiRef?.requestRender?.();
		}
	});

	// Keep the panel honest even when nothing else triggers a repaint.
	const tick = setInterval(() => {
		if (state.visible) tuiRef?.requestRender?.();
	}, 1000);
	tick.unref?.();

	pi.registerCommand("memory", {
		description: "Panel: memoria persistente del proyecto",
		handler: async (ctx) => {
			state.tab = "memory";
			state.memLoadedAt = 0;
			const c = ctx ?? ctxRef;
			tuiRef?.requestRender?.();
			try {
				c?.ui?.setStatus?.("side-panel", "panel memory");
			} catch {
				/* ignore */
			}
		},
	});

	pi.registerShortcut("alt+m", {
		description: "Panel: memoria del proyecto",
		handler: async () => {
			state.tab = "memory";
			state.memLoadedAt = 0;
			tuiRef?.requestRender?.();
		},
	});

	pi.registerShortcut("alt+e", {
		description: "Editar el archivo abierto en el panel",
		handler: async (ctx) => {
			if (state.editing) saveEdit(ctx);
			else startEdit(ctx);
		},
	});

	pi.registerCommand("panel", {
		description: "Mostrar u ocultar el panel lateral",
		handler: async (ctx) => {
			state.visible = !state.visible;
			tuiRef?.requestRender?.();
			ctx.ui.setStatus("side-panel", state.visible ? "panel visible" : "panel oculto");
		},
	});

	pi.registerCommand("serve", {
		description: "Servir el proyecto localmente y mostrar la URL del preview",
		handler: async (ctx) => {
			if (state.server) {
				ctx.ui.notify(`Ya está corriendo: ${state.serveUrl}`, "info");
				return;
			}

			const html = existsSync(join(state.root, "index.html"))
				? state.root
				: existsSync(join(state.root, "public/index.html"))
					? join(state.root, "public")
					: state.root;

			const child = spawn("python3", ["-m", "http.server", String(SERVE_PORT)], {
				cwd: html,
				stdio: "ignore",
			});
			state.server = child;
			state.serveUrl = `http://localhost:${SERVE_PORT}`;

			child.on("exit", () => {
				state.server = null;
				state.serveUrl = "";
			});

			setTimeout(() => {
				ctx.ui.notify(`Preview: ${state.serveUrl}`, "info");
			}, 300);
		},
	});

	pi.registerCommand("stop", {
		description: "Detener el servidor local del preview",
		handler: async (ctx) => {
			if (!state.server) {
				ctx.ui.notify("No hay servidor corriendo", "info");
				return;
			}
			stopServer();
			ctx.ui.notify("Servidor detenido", "info");
		},
	});
}
