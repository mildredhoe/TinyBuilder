/**
 * project-check — verify the project after the agent finishes a turn.
 *
 * Runs cheap, language-aware checks and feeds real problems back to the model
 * as a follow-up, classified by kind so it knows what to do:
 *
 *   missing-module   a relative import points at nothing (module to create)
 *   missing-file     a config references a file that is not there
 *   missing-package  bare import with no dependency declared (npm install)
 *   missing-dir      an import path segment does not exist
 *   broken-script    package.json script that cannot work
 *   syntax           python parse error
 *   typecheck        project's own typecheck output
 *
 * ctrl+shift+c runs the checks on demand.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKIP_DIRS = new Set([
	"node_modules", ".git", ".next", "dist", "build", ".cache",
	"__pycache__", ".venv", "venv", ".turbo", "coverage", "out",
]);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const NODE_BUILTINS = new Set([
	"assert", "buffer", "child_process", "crypto", "dns", "events", "fs",
	"http", "https", "net", "os", "path", "process", "querystring", "stream",
	"string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
	"worker_threads", "zlib",
]);

type Kind =
	| "missing-module"
	| "missing-file"
	| "missing-package"
	| "missing-dir"
	| "broken-script"
	| "stack-mix"
	| "syntax"
	| "typecheck";

type Problem = { file: string; kind: Kind; message: string; fix: string };

const state = {
	lastReport: "",
	running: false,
	cooldownUntil: 0,
	reports: 0,
};

// ── walking ─────────────────────────────────────────────────────────────
function walk(root: string, out: string[], depth = 0): void {
	if (depth > 6 || out.length > 4000) return;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
		const full = join(root, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(full, out, depth + 1);
		else if (CODE_EXT.has(extname(name))) out.push(full);
	}
}

function existsAny(paths: string[]): boolean {
	return paths.some((p) => existsSync(p));
}

/** All the file shapes a relative spec could resolve to. */
function candidatesFor(fromFile: string, spec: string): string[] {
	const base = resolve(dirname(fromFile), spec);
	return [
		base,
		`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
		`${base}.mjs`, `${base}.cjs`, `${base}.py`, `${base}.json`,
		join(base, "index.ts"), join(base, "index.tsx"),
		join(base, "index.js"), join(base, "index.jsx"),
	];
}

// ── import analysis ─────────────────────────────────────────────────────
function checkRelativeImports(root: string): Problem[] {
	const files: string[] = [];
	walk(root, files);
	const problems: Problem[] = [];

	const jsRe = /(?:from\s+|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
	const pyRe = /^\s*from\s+(\.{1,2}[\w.]*)\s+import\s+/gm;

	for (const file of files) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const rel = relative(root, file);

		if (file.endsWith(".py")) {
			let m: RegExpExecArray | null;
			while ((m = pyRe.exec(text))) {
				const spec = m[1];
				if (/^\.{1,2}$/.test(spec)) continue;
				const parts = spec.split(".");
				const dirPart = parts.shift() ?? ".";
				const modPath = resolve(dirname(file), dirPart.replace(/\./g, "/"), parts.join("/"));
				if (!existsAny([`${modPath}.py`, modPath, join(modPath, "__init__.py")])) {
					problems.push({
						file: rel,
						kind: "missing-module",
						message: `importa ${spec}, que no existe`,
						fix: `crear ${relative(root, modPath)}.py o ajustar el import`,
					});
				}
			}
			continue;
		}

		if (!JS_EXT.has(extname(file))) continue;

		let m: RegExpExecArray | null;
		const seen = new Set<string>();
		while ((m = jsRe.exec(text))) {
			const spec = m[1];
			if (seen.has(spec)) continue;
			seen.add(spec);

			const cands = candidatesFor(file, spec);
			if (existsAny(cands)) continue;

			// Distinguish "the folder is missing" from "the file is missing".
			const target = resolve(dirname(file), spec);
			const parentDir = dirname(target);

			if (!existsSync(parentDir)) {
				problems.push({
					file: rel,
					kind: "missing-dir",
					message: `importa ${spec} y la carpeta ${relative(root, parentDir) || "."} no existe`,
					fix: `crear la carpeta ${relative(root, parentDir)} y el archivo, o corregir la ruta`,
				});
			} else {
				problems.push({
					file: rel,
					kind: "missing-module",
					message: `importa ${spec} y ese módulo no existe`,
					fix: `crear ${relative(root, target)}.(ts|tsx|js) con lo que se importa, o corregir el import`,
				});
			}
		}
	}

	return problems;
}

// ── package.json ────────────────────────────────────────────────────────
function checkPackage(root: string): Problem[] {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) return [];

	let pkg: any;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch (e) {
		return [
			{
				file: "package.json",
				kind: "syntax",
				message: `JSON inválido: ${(e as Error).message}`,
				fix: "corregir el JSON de package.json",
			},
		];
	}

	const problems: Problem[] = [];
	const scripts: Record<string, string> = pkg.scripts ?? {};
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

	// Scripts that call themselves, or call a binary that is not installed.
	for (const [name, cmd] of Object.entries(scripts)) {
		if (typeof cmd !== "string") continue;

		if (new RegExp(`npm run ${name}\\b`).test(cmd)) {
			problems.push({
				file: "package.json",
				kind: "broken-script",
				message: `el script "${name}" se llama a sí mismo (bucle infinito)`,
				fix: `poner el comando real que debe ejecutar "${name}"`,
			});
			continue;
		}

		// First token of the command, if it is a local binary.
		const bin = cmd.trim().split(/\s+/)[0];
		if (!bin || bin.startsWith("-") || bin === "npm" || bin === "node" || bin === "sh") continue;
		if (bin.includes("/") || bin.startsWith("$")) continue;

		const known =
			deps[bin] ||
			deps[`@types/${bin}`] ||
			/bin^(tsc|next|vite|eslint|prettier|jest|vitest|nodemon|tsx|ts-node)$/.test(bin);

		if (!known && Object.keys(deps).length > 0) {
			const installed = existsSync(join(root, "node_modules", ".bin", bin));
			if (!installed) {
				problems.push({
					file: "package.json",
					kind: "missing-package",
					message: `el script "${name}" usa "${bin}" pero no está en dependencies`,
					fix: `añadir ${bin} a dependencies y ejecutar npm install`,
				});
			}
		}
	}

	// Bare imports with no declared dependency.
	const files: string[] = [];
	walk(root, files);
	const missing = new Set<string>();
	const bareRe = /(?:from\s+|require\(\s*)["']([^."'][^"']*)["']/g;

	for (const file of files) {
		if (!JS_EXT.has(extname(file))) continue;
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		let m: RegExpExecArray | null;
		while ((m = bareRe.exec(text))) {
			const spec = m[1];
			if (spec.startsWith("node:") || spec.startsWith("@/") || spec.startsWith("~")) continue;

			const pkgName = spec.startsWith("@")
				? spec.split("/").slice(0, 2).join("/")
				: spec.split("/")[0];

			if (!pkgName || NODE_BUILTINS.has(pkgName)) continue;
			if (pkgName === "next" || pkgName === "react" || pkgName === "react-dom") continue;
			if (deps[pkgName]) continue;

			missing.add(pkgName);
		}
	}

	for (const name of missing) {
		problems.push({
			file: "package.json",
			kind: "missing-package",
			message: `el código importa "${name}" pero no está en dependencies`,
			fix: `añadir "${name}" a dependencies y ejecutar npm install`,
		});
	}

	// Stack mixing: the wrong tech family inside a Next/React project.
	const depsText = JSON.stringify(deps).toLowerCase();
	const isNext = /next/.test(depsText) || existsSync(join(root, "next.config.js")) || existsSync(join(root, "next.config.mjs"));
	if (isNext) {
		const foreign = new Set<string>();
		for (const file of files) {
			if (!JS_EXT.has(extname(file))) continue;
			let text = "";
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (/from\s+["']vue["']|from\s+["']@vue\/|from\s+["']vite["']|from\s+["']@vitejs\//.test(text)) {
				foreign.add(relative(root, file));
			}
		}
		for (const f of foreign) {
			problems.push({
				file: f,
				kind: "stack-mix",
				message: "importa Vue/Vite dentro de un proyecto Next/React",
				fix: "reescribir ese archivo con React/Next; no adaptar código Vue",
			});
		}
	}

	return problems;
}

// ── python syntax ───────────────────────────────────────────────────────
function checkPythonSyntax(root: string): Promise<Problem[]> {
	const files: string[] = [];
	walk(root, files);
	const py = files.filter((f) => f.endsWith(".py"));
	if (py.length === 0) return Promise.resolve([]);

	const script =
		"import ast,sys\n" +
		"for p in sys.argv[1:]:\n" +
		"    try: ast.parse(open(p).read(), p)\n" +
		"    except SyntaxError as e: print(f'{p}\\t{e.lineno}\\t{e.msg}')\n";

	return new Promise((resolveP) => {
		execFile(
			"python3",
			["-c", script, ...py],
			{ timeout: 10000, maxBuffer: 1024 * 1024 },
			(_err, stdout) => {
				const out = String(stdout || "").trim();
				if (!out) return resolveP([]);
				resolveP(
					out.split("\n").slice(0, 15).map((line) => {
						const [p, lineno, ...rest] = line.split("\t");
						return {
							file: relative(root, p),
							kind: "syntax" as Kind,
							message: `error de sintaxis línea ${lineno}: ${rest.join(" ")}`,
							fix: "corregir la sintaxis de ese bloque",
						};
					}),
				);
			},
		);
	});
}

// ── project typecheck ───────────────────────────────────────────────────
function checkTypeScript(root: string): Promise<Problem[]> {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) return Promise.resolve([]);

	let script: string | null = null;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const scripts = pkg.scripts ?? {};
		if (scripts.typecheck) script = "typecheck";
		else if (scripts["type-check"]) script = "type-check";
	} catch {
		return Promise.resolve([]);
	}
	if (!script) return Promise.resolve([]);
	if (!existsSync(join(root, "node_modules", ".bin", "tsc"))) return Promise.resolve([]);

	return new Promise((resolveP) => {
		execFile(
			"npm",
			["run", script, "--silent"],
			{ cwd: root, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
			(_err, stdout, stderr) => {
				const text = `${stdout || ""}\n${stderr || ""}`;
				const hits = text
					.split("\n")
					.filter((l) => /\.(ts|tsx)\(\d+,\d+\): error TS\d+/.test(l))
					.slice(0, 12);

				resolveP(
					hits.map((line) => {
						const m = /^(.+?)\((\d+),(\d+)\): error TS\d+: (.+)$/.exec(line.trim());
						return m
							? {
									file: relative(root, resolve(root, m[1])),
									kind: "typecheck" as Kind,
									message: `línea ${m[2]}: ${m[4]}`,
									fix: "corregir el tipo o la firma indicada",
								}
							: {
									file: "typecheck",
									kind: "typecheck" as Kind,
									message: line.trim().slice(0, 140),
									fix: "revisar el error de tipos",
								};
					}),
				);
			},
		);
	});
}

// ── report ──────────────────────────────────────────────────────────────
const KIND_LABEL: Record<Kind, string> = {
	"missing-module": "MÓDULO FALTA",
	"missing-file": "ARCHIVO FALTA",
	"missing-package": "PAQUETE FALTA",
	"missing-dir": "CARPETA FALTA",
	"stack-mix": "STACK MEZCLADO",
	"broken-script": "SCRIPT ROTO",
	syntax: "SINTAXIS",
	typecheck: "TIPOS",
};

const KIND_HINT: Record<Kind, string> = {
	"missing-module":
		"El archivo existe pero importa un módulo que no está en disco. No es una ruta mala: falta crear ese módulo (o cambiar el import a uno que exista).",
	"missing-file":
		"Alguna configuración apunta a un archivo que no existe.",
	"missing-package":
		"Un paquete npm se importa o se usa en un script pero no está en package.json. Hay que declararlo e instalar.",
	"missing-dir":
		"La ruta del import apunta a una carpeta que no existe.",
	"broken-script":
		"Un script de package.json no puede funcionar tal como está escrito.",
	syntax: "Hay un error de sintaxis que impide interpretar el archivo.",
	typecheck: "El chequeo de tipos del propio proyecto falló.",
};

async function runChecks(root: string): Promise<string> {
	const all: Problem[] = [
		...checkRelativeImports(root),
		...checkPackage(root),
		...(await checkPythonSyntax(root)),
		...(await checkTypeScript(root)),
	];

	if (all.length === 0) return "";

	// Group by kind so the model sees the shape of the breakage first.
	const byKind = new Map<Kind, Problem[]>();
	for (const p of all) {
		const list = byKind.get(p.kind) ?? [];
		list.push(p);
		byKind.set(p.kind, list);
	}

	const parts: string[] = [];
	parts.push(`El proyecto no está consistente: ${all.length} problema(s).`);

	for (const [kind, list] of byKind) {
		parts.push("");
		parts.push(`## ${KIND_LABEL[kind]} (${list.length})`);
		parts.push(KIND_HINT[kind]);

		const seen = new Set<string>();
		let shown = 0;
		for (const p of list) {
			const key = `${p.file}|${p.message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			parts.push(`- ${p.file}: ${p.message}`);
			parts.push(`  arreglo: ${p.fix}`);
			if (++shown >= 8) {
				if (list.length > shown) parts.push(`- … y ${list.length - shown} más iguales`);
				break;
			}
		}
	}

	return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
	let ctxRef: any = null;

	async function verify(ctx: any, force = false): Promise<void> {
		if (state.running) return;
		if (!force && Date.now() < state.cooldownUntil) return;
		if (state.reports >= 3 && !force) {
			ctx.ui.setStatus("project-check", "check: pausado (3 revisiones)");
			return;
		}

		state.running = true;
		try {
			const report = await runChecks(ctx.cwd);

			if (!report) {
				state.lastReport = "";
				ctx.ui.setStatus("project-check", "check: ok");
				return;
			}

			if (report === state.lastReport) {
				ctx.ui.setStatus("project-check", "check: sin cambios");
				return;
			}

			state.lastReport = report;
			state.reports++;
			state.cooldownUntil = Date.now() + 20000;
			ctx.ui.setStatus("project-check", `check: ${state.reports}/3`);

			pi.sendUserMessage(
				[
					"Revisión automática del proyecto.",
					"Corrige los problemas con tus herramientas. No expliques: actúa.",
					"Si algo no se puede arreglar sin decidir por el usuario, dilo en una frase.",
					"",
					report,
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		} finally {
			state.running = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		await verify(ctx);
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Revisar el proyecto ahora",
		handler: async (ctx) => {
			state.lastReport = "";
			state.reports = 0;
			await verify(ctx ?? ctxRef, true);
			ctx.ui.notify("Revisión ejecutada", "info");
		},
	});

	pi.registerCommand("check", {
		description: "Revisar consistencia del proyecto",
		handler: async (ctx) => {
			state.lastReport = "";
			state.reports = 0;
			await verify(ctx ?? ctxRef, true);
		},
	});
}
