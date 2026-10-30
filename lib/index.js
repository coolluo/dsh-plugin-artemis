/**
 * index.js — dsh-plugin-artemis entry point.
 *
 * Five tools that hand a task to Google ARTEMIS, a dedicated Android automation
 * agent, and bring back the result — instead of driving adb one tap at a time:
 *   - artemis_run_task     start a task and wait for it
 *   - artemis_task         status / stop / inject instruction
 *   - artemis_device_state screenshot or element hierarchy
 *   - artemis_trace        step-by-step execution record
 *   - artemis_doctor       environment diagnosis (local + ARTEMIS)
 *
 * @module dsh-plugin-artemis
 */

import { ArtemisService } from "./artemis.js";
import { resolveConfig } from "./config.js";
import { registerBundledSkill } from "./skill.js";
import { registerArtemisTools } from "./tools.js";

/** Cordis plugin name. */
export const name = "dsh-artemis";

/** This plugin contributes tools; without the tool registry there is nothing to do. */
export const inject = ["tools"];

/**
 * Mount the plugin.
 * @param {object} ctx - cordis plugin context.
 * @param {object} [rawConfig] - config from the bundle patch or the settings page.
 */
export function apply(ctx, rawConfig = {}) {
	const { config, warnings } = resolveConfig(rawConfig);
	for (const warning of warnings) ctx.logger?.warn?.(`dsh-artemis: ${warning}`);

	const service = new ArtemisService({ config, logger: ctx.logger });
	ctx.effect(() => () => service.dispose(), "dsh-artemis: ARTEMIS MCP connection");

	registerArtemisTools(ctx, { service, getConfig: () => config });
	if (config.provideSkill) registerBundledSkill(ctx, ctx.logger);
}
