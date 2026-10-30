/**
 * skill.js — publish the bundled ARTEMIS playbook through `ctx.skills`.
 *
 * The package carries `skills/artemis/SKILL.md`; adding the bundle is enough,
 * because the Markdown file is parsed at load time and registered as a runtime
 * skill. No postinstall step, no files written outside the package.
 *
 * @module dsh-plugin-artemis/lib/skill
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_FILE = new URL("../skills/artemis/SKILL.md", import.meta.url);
const SKILL_DIR = new URL("../skills/artemis/", import.meta.url);

/**
 * Parse the frontmatter and body of a bundled SKILL.md.
 * @param {string} raw - file contents.
 * @returns {{name: string, description: string, content: string} | null} catalogue fields, or null when malformed.
 */
export function parseSkillMarkdown(raw) {
	const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (front === null) return null;
	const head = front[1] ?? "";
	const name = /^name:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1];
	const description = /^description:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1];
	if (name === undefined || description === undefined) return null;
	return { name, description, content: raw.slice(front[0].length).trim() };
}

/**
 * Register the bundled skill as a runtime contribution on `ctx.skills`.
 * @param {object} ctx - plugin context.
 * @param {{warn?: Function}} [logger] - logger used when the file is malformed.
 * @returns {boolean} whether a skill was registered.
 */
export function registerBundledSkill(ctx, logger) {
	const skills = ctx.get("skills");
	if (skills === undefined) return false;
	let skill;
	try {
		skill = parseSkillMarkdown(readFileSync(SKILL_FILE, "utf8"));
	} catch {
		skill = null;
	}
	if (skill === null) {
		logger?.warn?.("dsh-artemis: skills/artemis/SKILL.md is missing or malformed; tools stay available without the playbook");
		return false;
	}
	ctx.effect(
		() =>
			skills.register({
				name: skill.name,
				description: skill.description,
				content: skill.content,
				source: "runtime",
				resourceBase: { kind: "directory", path: fileURLToPath(SKILL_DIR) },
			}),
		"dsh-artemis: bundled skill",
	);
	return true;
}
