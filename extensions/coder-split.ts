/**
 * coder-split — two-model split for little-coder.
 *
 * Bonsai stays the main agent: it talks, reasons, reads and decides.
 * Qwen3.5-0.8B does the actual code writing.
 *
 * `write_code` asks the code model for a file from scratch.
 * `edit_code` asks it for the rewritten block only, then applies it here.
 * The built-in `write` / `edit` tools stay available as a last resort.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OLLAMA = process.env.CODER_SPLIT_URL ?? "http://127.0.0.1:11434/api/chat";
const CODER_MODEL = process.env.CODER_SPLIT_MODEL ?? "hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M";
const CODER_TIMEOUT_MS = Number(process.env.CODER_SPLIT_TIMEOUT ?? "180000");

type ChatResult = { ok: true; text: string } | { ok: false; error: string };

async function askCoder(system: string, user: string, signal?: AbortSignal): Promise<ChatResult> {
	const timeout = AbortSignal.timeout(CODER_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	try {
		const res = await fetch(OLLAMA, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer noop" },
			body: JSON.stringify({
				model: CODER_MODEL,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				// Qwen3.5 is a reasoning model. Without this it burns the whole
				// budget thinking and returns empty content. The native
				// /api/chat endpoint honours it; /v1/chat/completions does not.
				think: false,
				stream: false,
				options: {
					temperature: 0.1,
					top_p: 0.9,
					repeat_penalty: 1.15,
					num_predict: 4096,
				},
			}),
			signal: combined,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
		}

		const data = (await res.json()) as { message?: { content?: string } };
		const text = data.message?.content ?? "";
		return { ok: true, text };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

function unfence(text: string): string {
	const t = text.trim();
	const full = t.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/);
	if (full) return full[1];
	const open = t.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*)$/);
	if (open) return open[1].replace(/\n```\s*$/, "");
	return t;
}

/** Small models degenerate into repeating blocks; cut the loop. */
function dedupeRepeats(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let runStart = -1;
	let runLen = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i > 0 && line === lines[i - 1]) {
			runLen++;
			if (runLen > 3) continue;
		} else {
			runLen = 0;
		}
		out.push(line);
	}

	// Detect a repeated multi-line block that swallowed the tail.
	const joined = out.join("\n");
	const half = Math.floor(joined.length / 2);
	if (half > 200) {
		const a = joined.slice(0, half);
		const b = joined.slice(half, half * 2);
		if (a.trim() === b.trim()) return a;
	}

	return out.join("\n");
}

function cleanCode(text: string): string {
	let out = unfence(text);
	const fence = out.indexOf("```");
	if (fence > 0) out = unfence(out.slice(fence));
	out = dedupeRepeats(out);
	out = dropDuplicateBlocks(out);
	return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Remove a CSS/JS block that appears again later in the output. */
function dropDuplicateBlocks(text: string): string {
	const blocks = text.split(/(?<=})\s*\n\s*\n/);
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const block of blocks) {
		const key = block.replace(/\s+/g, " ").trim();
		if (!key) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(block);
	}
	return kept.join("\n\n");
}

const WRITE_SYSTEM = `You are a code generator. Output ONLY the complete file content.
No explanations. No markdown fences. No commentary.
Do not repeat yourself. Start directly with the first line of code and stop at the end of the file.`;

const EDIT_SYSTEM = `You edit text files. You receive the FULL current file and an instruction.
Output the FULL file with the change applied.
Keep every other line exactly as it was. Do not drop, shorten or summarize anything.
Output ONLY the file content. No explanations. No markdown fences.`;

/**
 * Replace the rule whose selector matches, keeping the rest of the file.
 * Small models cannot follow structured patch formats, so we ask them for the
 * rewritten block and do the splice ourselves.
 */
function replaceRule(file: string, selector: string, block: string): { ok: true; content: string } | { ok: false; error: string } {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(^|\\n)${escaped}\\s*\\{[^}]*\\}`, "m");
	if (!re.test(file)) return { ok: false, error: `Selector "${selector}" not found in file.` };
	return { ok: true, content: file.replace(re, `$1${block.trim()}`) };
}

/** Strip a leading slash so "/package.json" lands inside the project, never at / */
function safePath(root: string, path: string): { abs: string; rel: string } {
	const cleaned = path.replace(/^\/+/, "").replace(/^\.\//, "");
	const abs = resolve(root, cleaned);
	const rel = relative(root, abs);
	return { abs, rel };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("coder-split", `coder: ${CODER_MODEL}`);

		// Hide write/edit from the model's tool schema entirely. Prompt rules
		// are not enough for a 4B: if the tool is visible it will try it.
		try {
			const tools = pi.getActiveTools();
			const filtered = tools.filter((t) => t !== "write" && t !== "edit");
			if (filtered.length !== tools.length) {
				pi.setActiveTools(filtered);
			}

		} catch {
			/* older pi without the API */
		}
	});

	// The built-in write/edit require whole-file rewrites or JSON patch arrays,
	// neither of which a small model can produce reliably. Route them to the
	// code model instead of letting the harness redirect the agent in circles.
	pi.on("tool_call", async (event) => {
		const name = String((event as any).toolName ?? "").toLowerCase();
		if (name !== "write" && name !== "edit") return;

		const suggestion =
			name === "write"
				? "Call write_code with {path, instruction}. That is the only file-writing tool."
				: "Call edit_code with {path, instruction}. That is the only file-editing tool.";
		return {
			block: true,
			reason: `TOOL ${name} DOES NOT EXIST. Do not write file content yourself. ${suggestion}`,
		};
	});

	pi.registerTool({
		name: "write_code",
		label: "Write code",
		description:
			"Create or overwrite a file. A separate code model writes the content. Give a precise instruction of what the file must contain.",
		promptSnippet: "Create a file — the only available write tool",
		promptGuidelines: [
			"write_code is the ONLY way to create files in this session.",
			"The built-in write tool does not exist here; calling it always fails.",
			"write_code overwrites existing files safely; do not check whether the file exists.",
			"Be specific in `instruction`: language, purpose, required sections, exact class/function names.",
			"If write_code returns an error, retry it once with a clearer instruction.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the project root" }),
			instruction: Type.String({ description: "What the file must contain, in detail" }),
			context: Type.Optional(Type.String({ description: "Extra context: conventions, related files" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { abs, rel } = safePath(ctx.cwd, params.path);
			const prompt = [
				`File: ${rel}`,
				params.context ? `Context:\n${params.context}` : "",
				`Instruction:\n${params.instruction}`,
			]
				.filter(Boolean)
				.join("\n\n");

			const result = await askCoder(WRITE_SYSTEM, prompt, signal);
			if (!result.ok) {
				return { content: [{ type: "text", text: `Coder failed: ${result.error}` }], isError: true };
			}

			const code = cleanCode(result.text);
			if (!code.trim()) {
				return { content: [{ type: "text", text: "Coder returned empty content." }], isError: true };
			}

			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, code, "utf8");

			const lines = code.split("\n").length;
			return {
				content: [{ type: "text", text: `Wrote ${params.path} (${lines} lines) via ${CODER_MODEL}.` }],
				details: { path: params.path, lines, model: CODER_MODEL },
			};
		},
	});

	pi.registerTool({
		name: "edit_code",
		label: "Edit code",
		description:
			"Modify an existing file. A separate code model rewrites the affected part. Works for CSS, HTML, Markdown, JS and any text file.",
		promptSnippet: "Modify an existing file (patch produced by the code model)",
		promptGuidelines: [
			"Read the file first, then describe precisely which lines must change.",
			"edit_code is the ONLY way to modify files in this session.",
			"The built-in edit tool does not exist here; calling it always fails.",
			"edit_code needs no patch format: describe the change in prose.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the project root" }),
			instruction: Type.String({ description: "Exactly what must change in the file" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { abs, rel } = safePath(ctx.cwd, params.path);
			let current: string;
			try {
				current = await readFile(abs, "utf8");
			} catch {
				return { content: [{ type: "text", text: `File not found: ${params.path}` }], isError: true };
			}

			// Find the snippet the instruction refers to. For CSS we target the rule;
			// for prose/code we send the whole file and replace it wholesale, since
			// small models cannot produce reliable structured patches.
			const isCss = /\.[A-Za-z0-9_-]+\s*\{|#[A-Za-z0-9_-]+\s*\{/.test(current) && !current.includes("\n#");

			if (isCss) {
				const selectorMatch = current.match(/(^|\n)([.#][A-Za-z0-9_-]+|:root|body|html)\s*\{/);
				const selector = selectorMatch?.[2];
				if (!selector) {
					return { content: [{ type: "text", text: "Could not determine a CSS selector." }], isError: true };
				}

				const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const ruleRe = new RegExp(`${escaped}\\s*\\{[^}]*\\}`);
				const rule = current.match(ruleRe)?.[0];
				if (!rule) {
					return { content: [{ type: "text", text: `Rule "${selector}" not found.` }], isError: true };
				}

				const block = await askCoder(EDIT_SYSTEM, `Instruction: ${params.instruction}\n\nSnippet:\n${rule}`, signal);
				if (!block.ok) {
					return { content: [{ type: "text", text: `Coder failed: ${block.error}` }], isError: true };
				}

				const cleaned = cleanCode(block.text);
				const applied = replaceRule(current, selector, cleaned);
				if (!applied.ok) {
					return { content: [{ type: "text", text: `Edit failed: ${applied.error}` }], isError: true };
				}

				await writeFile(abs, applied.content, "utf8");
				const lines = applied.content.split("\n").length;
				return {
					content: [{ type: "text", text: `Updated ${params.path} (${lines} lines) via ${CODER_MODEL}.` }],
					details: { path: params.path, lines, model: CODER_MODEL, selector },
				};
			}

			// Prose / markup / scripts: hand the whole file to the coder.
			const block = await askCoder(
				EDIT_SYSTEM,
				`Change to apply:\n${params.instruction}\n\nThe file currently has ${current.split("\n").length} lines. Output all of them with the change.\n\nCurrent file:\n${current}`,
				signal,
			);
			if (!block.ok) {
				return { content: [{ type: "text", text: `Coder failed: ${block.error}` }], isError: true };
			}

			const cleaned = cleanCode(block.text);
			if (!cleaned.trim()) {
				return { content: [{ type: "text", text: "Coder returned empty content; file unchanged." }], isError: true };
			}

			await writeFile(abs, cleaned, "utf8");
			const lines = cleaned.split("\n").length;
			return {
				content: [{ type: "text", text: `Updated ${params.path} (${lines} lines) via ${CODER_MODEL}.` }],
				details: { path: params.path, lines, model: CODER_MODEL, mode: "whole-file" },
			};
		},
	});
}
