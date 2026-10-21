/**
 * file-guard — check every file the moment the agent writes it.
 *
 * project-check catches problems at the end of a turn; by then the model has
 * moved on and a 4B cannot reconstruct what it broke. This guard runs on each
 * write_code / edit_code result and, if the file is broken, steers the model
 * straight back with the exact error and the exact file.
 *
 * Checks per file:
 *   syntax      TypeScript/JSX parse (typescript API) or python ast
 *   imports     every relative import resolves on disk
 *   packages    every bare import is declared in package.json
 *   stack       no vue/vite/express inside a next/react project
 *   markup      balanced tags (html) and braces (css)
 *
 * Max 2 repairs per file, so a stubborn error cannot spin forever.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const nodeRequire = createRequire(import.meta.url);

const SKIP_DIRS = new Set([
	"node_modules", ".git", ".next", "dist", "build", ".cache",
	"__pycache__", ".venv", "venv", ".turbo", "coverage", "out",
]);

const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const NODE_BUILTINS = new Set([
	"assert", "buffer", "child_process", "crypto", "dns", "events", "fs",
	"http", "https", "net", "os", "path", "process", "querystring", "stream",
	"string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
	"worker_threads", "zlib",
]);

const MAX_REPAIRS = 2;

type Issue = { kind: string; message: string };

const repairCount = new Map<string, number>();

// ── typescript parser, resolved from the project ────────────────────────
function loadTs(root: string): any | null {
	const candidates = [
		join(root, "node_modules", "typescript"),
		join(root, "..", "node_modules", "typescript"),
	];
	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			return nodeRequire(path);
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Syntax-only parse: no type checking, no project graph. */
function syntaxIssuesTs(root: string, file: string, rel: string): Issue[] {
	const ts = loadTs(root);
	if (!ts) return [];

	let source = "";
	try {
		source = readFileSync(file, "utf8");
	} catch {
		return [];
	}

	const ext = extname(file);
	const kind =
		ext === ".tsx" ? ts.ScriptKind.TSX :
		ext === ".jsx" ? ts.ScriptKind.JSX :
		ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JS :
		ts.ScriptKind.TS;

	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
	const found: any[] = (sf as any).parseDiagnostics ?? [];

	return found.slice(0, 5).map((d: any) => {
		const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
		const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
		return {
			kind: "syntax",
			message: `línea ${pos.line + 1}: ${text}`,
		};
	});
}

function syntaxIssuesPy(root: string, file: string): Promise<Issue[]> {
	return new Promise((resolveP) => {
		const script =
			"import ast,sys\n" +
			"try: ast.parse(open(sys.argv[1]).read(), sys.argv[1])\n" +
			"except SyntaxError as e: print(f'{e.lineno}: {e.msg}')\n";

		execFile("python3", ["-c", script, file], { timeout: 8000 }, (_e, out) => {
			const text = String(out || "").trim();
			if (!text) return resolveP([]);
			resolveP(text.split("\n").slice(0, 5).map((line) => ({ kind: "syntax", message: line })));
		});
	});
}

function markupIssues(file: string): Issue[] {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const ext = extname(file);

	if (ext === ".css") {
		const open = (text.match(/\{/g) ?? []).length;
		const close = (text.match(/\}/g) ?? []).length;
		return open === close ? [] : [{ kind: "syntax", message: `llaves desbalanceadas: ${open} { vs ${close} }` }];
	}

	if (ext === ".html") {
		// Count only common block tags; void elements are ignored.
		const voidTags = new Set(["br", "img", "input", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
		const stack: string[] = [];
		const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const closing = m[1] === "/";
			const tag = m[2].toLowerCase();
			const selfClose = m[3] === "/";
			if (voidTags.has(tag) || selfClose) continue;
			if (!closing) stack.push(tag);
			else if (stack.pop() !== tag) return [{ kind: "syntax", message: `etiqueta </${tag}> no cierra la correcta` }];
		}
		if (stack.length > 0) return [{ kind: "syntax", message: `etiquetas sin cerrar: ${stack.slice(-3).join(", ")}` }];
	}

	return [];
}

// ── imports and packages ────────────────────────────────────────────────
function resolves(fromFile: string, spec: string): boolean {
	const base = resolve(dirname(fromFile), spec);
	return [
		base,
		`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
		`${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}.py`,
		join(base, "index.ts"), join(base, "index.tsx"),
		join(base, "index.js"), join(base, "index.jsx"),
	].some((p) => existsSync(p));
}

function importIssues(root: string, file: string): Issue[] {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}

	const issues: Issue[] = [];
	const relRe = /(?:from\s+|require\(\s*)["'](\.[^"']+)["']/g;
	const bareRe = /(?:from\s+|require\(\s*)["']([^."'][^"']*)["']/g;

	let pkg: any = {};
	const pkgPath = join(root, "package.json");
	if (existsSync(pkgPath)) {
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		} catch {
			/* ignore */
		}
	}
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

	const project = JSON.stringify(deps).toLowerCase();
	const isNext = /next/.test(project) || existsSync(join(root, "next.config.js")) || existsSync(join(root, "next.config.mjs"));

	let m: RegExpExecArray | null;
	const seen = new Set<string>();

	while ((m = relRe.exec(text))) {
		const spec = m[1];
		if (seen.has(spec)) continue;
		seen.add(spec);
		if (!resolves(file, spec)) {
			issues.push({ kind: "import", message: `importa "${spec}" y ese archivo no existe` });
		}
	}

	while ((m = bareRe.exec(text))) {
		const spec = m[1];
		if (spec.startsWith("node:") || spec.startsWith("@/") || spec.startsWith("~")) continue;

		const name = spec.startsWith("@")
			? spec.split("/").slice(0, 2).join("/")
			: spec.split("/")[0];

		if (!name || NODE_BUILTINS.has(name)) continue;

		// Stack mixing is worse than a missing dependency.
		if (isNext && (name === "vue" || name === "@vue/compiler-vue3" || name === "vite" || name === "express")) {
			issues.push({
				kind: "stack",
				message: `mezcla de stacks: "${name}" en un proyecto Next/React`,
			});
			continue;
		}

		if (!deps[name] && !["next", "react", "react-dom"].includes(name)) {
			issues.push({ kind: "package", message: `importa "${name}" pero no está en package.json` });
		}
	}

	return issues;
}

// ── orchestration ───────────────────────────────────────────────────────
async function checkFile(root: string, rel: string): Promise<Issue[]> {
	const abs = resolve(root, rel);
	if (!existsSync(abs)) return [];
	const ext = extname(abs);

	let issues: Issue[] = [];

	if (JS_EXT.has(ext)) {
		issues.push(...syntaxIssuesTs(root, abs, rel));
		issues.push(...importIssues(root, abs));
	} else if (ext === ".py") {
		issues.push(...(await syntaxIssuesPy(root, abs)));
	} else if (ext === ".css" || ext === ".html") {
		issues.push(...markupIssues(abs));
	}

	// Dedupe by kind+message.
	const seen = new Set<string>();
	return issues.filter((i) => {
		const key = `${i.kind}|${i.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const KIND_HINT: Record<string, string> = {
	syntax: "El archivo no parsea. Reescríbelo completo y verifica que cada llave, paréntesis y etiqueta cierre.",
	import: "Importa un archivo que no existe. Crea ese archivo o corrige el import a uno que sí exista.",
	package: "Usa un paquete que no está declarado. Declara el paquete correcto en package.json o usa uno que ya exista.",
	stack: "Mezclaste tecnologías incompatibles. Este proyecto es Next/React: no uses Vue, Vite ni Express.",
};

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event: any, ctx) => {
		const tool = String(event?.toolName ?? "");
		if (tool !== "write_code" && tool !== "edit_code") return;
		if (event?.isError) return;

		const path = event?.input?.path ?? event?.details?.path;
		if (typeof path !== "string" || !path) return;

		const rel = relative(ctx.cwd, resolve(ctx.cwd, path));
		const issues = await checkFile(ctx.cwd, rel);

		if (issues.length === 0) {
			repairCount.delete(rel);
			ctx.ui.setStatus("file-guard", `guard: ok ${rel}`);
			return;
		}

		const attempts = repairCount.get(rel) ?? 0;
		if (attempts >= MAX_REPAIRS) {
			ctx.ui.setStatus("file-guard", `guard: ${rel} sigue roto (${issues.length})`);
			return;
		}
		repairCount.set(rel, attempts + 1);

		const lines = issues.slice(0, 6).map((i) => `- [${i.kind}] ${i.message}`);
		const hints = [...new Set(issues.map((i) => i.kind))]
			.map((k) => `- ${KIND_HINT[k] ?? ""}`)
			.filter(Boolean);

		ctx.ui.setStatus("file-guard", `guard: ${rel} roto (${issues.length})`);

		pi.sendUserMessage(
			[
				`El archivo ${rel} quedó mal (intento ${attempts + 1}/${MAX_REPAIRS}).`,
				"",
				"Problemas:",
				...lines,
				"",
				"Cómo arreglarlo:",
				...hints,
				"",
				`Usa write_code sobre ${rel} con el archivo completo y correcto. No expliques: corrígelo.`,
			].join("\n"),
			{ deliverAs: "steer" },
		);
	});
}
