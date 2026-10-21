/**
 * user-skills — inject user-authored skills into the turn when they match.
 *
 * little-coder only loads the skills bundled in its package, so domain
 * knowledge like "how to build a static site" or "how to structure a SaaS"
 * had nowhere to live. This loader reads the SKILL.md of each folder under
 * ~/.config/little-coder/skills
 * and appends the skills whose keywords match the user prompt on each turn.
 *
 * Format: YAML frontmatter with name, description, keywords (or triggers).
 * The body is the guidance text.
 *
 * Budget: at most MAX_SKILLS per turn and MAX_CHARS total, so a 4B model is
 * not drowned in instructions it cannot follow anyway.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Skills del proyecto si están al lado de la extensión; si no, las globales.
const LOCAL_SKILLS = join(dirname(new URL(import.meta.url).pathname), "..", "skills");
const SKILLS_DIR = existsSync(LOCAL_SKILLS)
	? LOCAL_SKILLS
	: join(homedir(), ".config", "little-coder", "skills");
const TEMPLATES_DIR = join(homedir(), ".config", "little-coder", "templates");
const MAX_SKILLS = 2;
const MAX_CHARS = 4000;

type Skill = {
	name: string;
	description: string;
	keywords: string[];
	body: string;
	cost: number;
};

let cache: Skill[] | null = null;

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!m) return { meta: {}, body: text };

	const meta: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return { meta, body: m[2] };
}

function listFrom(value: string | undefined): string[] {
	if (!value) return [];
	// Accept [a, b, c] or comma-separated text.
	const clean = value.replace(/^\[|\]$/g, "");
	return clean
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase())
		.filter(Boolean);
}

function loadSkills(): Skill[] {
	if (cache) return cache;
	if (!existsSync(SKILLS_DIR)) {
		cache = [];
		return cache;
	}

	const skills: Skill[] = [];
	for (const entry of readdirSync(SKILLS_DIR)) {
		const file = join(SKILLS_DIR, entry, "SKILL.md");
		if (!existsSync(file)) continue;
		try {
			const text = readFileSync(file, "utf8");
			const { meta, body } = parseFrontmatter(text);
			skills.push({
				name: meta.name || entry,
				description: meta.description || "",
				keywords: [...listFrom(meta.keywords), ...listFrom(meta.triggers)],
				body: body.trim(),
				cost: Number(meta.token_cost) || 0,
			});
		} catch {
			/* skip unreadable */
		}
	}

	cache = skills;
	return skills;
}

/** How well does this skill match the prompt? 0 means no match. */
function score(skill: Skill, prompt: string): number {
	if (skill.keywords.length === 0) return 0;
	let hits = 0;
	for (const kw of skill.keywords) {
		if (kw && prompt.includes(kw)) hits++;
	}
	return hits;
}

export default function (pi: ExtensionAPI) {
	let lastPrompt = "";

	pi.on("before_agent_start", async (event: any, ctx) => {
		const prompt = String(event?.prompt ?? event?.message ?? "").toLowerCase();
		if (!prompt) return;
		lastPrompt = prompt;

		const skills = loadSkills();
		if (skills.length === 0) return;

		const ranked = skills
			.map((s) => ({ skill: s, hits: score(s, prompt) }))
			.filter((r) => r.hits > 0)
			.sort((a, b) => b.hits - a.hits)
			.slice(0, MAX_SKILLS);

		if (ranked.length === 0) return;

		// El modelo no expande variables de shell: le damos la ruta real.
		const projectHome = dirname(dirname(LOCAL_SKILLS));
		const withPaths = (text: string) =>
			text.replace(/\$TINYBUILDER_HOME/g, projectHome);

		const blocks: string[] = [];
		let used = 0;
		for (const { skill } of ranked) {
			const body = withPaths(skill.body);
			if (used + body.length > MAX_CHARS) continue;
			blocks.push(`### ${skill.name}\n${skill.description}\n\n${body}`);
			used += body.length;
		}
		if (blocks.length === 0) return;

		ctx.ui.setStatus("user-skills", `skills: ${ranked.map((r) => r.skill.name).join(", ")}`);

		// Append to the system prompt: this is the only hook path that reliably
		// affects the very turn the user just typed.
		return {
			systemPrompt:
				`${event.systemPrompt}\n\n## Conocimiento del proyecto (sigue estas reglas)\n\n${blocks.join("\n\n")}\n\nTemplates disponibles en ${TEMPLATES_DIR} (cópialos con cp -R, no los reescribas).`,
		};
	});

	pi.registerCommand("skills-reload", {
		description: "Recargar skills de usuario",
		handler: async (ctx) => {
			cache = null;
			const all = loadSkills();
			ctx.ui.notify(`${all.length} skill(s): ${all.map((s) => s.name).join(", ") || "ninguna"}`, "info");
		},
	});
}
