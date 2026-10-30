/**
 * config.js — resolved plugin configuration.
 *
 * Every field is optional: an empty config means "find ARTEMIS and use Flash".
 * Resolution never throws; a bad value falls back to its default and is
 * reported in `warnings`, which `artemis_doctor` surfaces.
 *
 * @module dsh-plugin-artemis/lib/config
 */

/** Default values for every configuration field. */
export const DEFAULTS = Object.freeze({
	/** ARTEMIS checkout (the directory holding `mcp_server/` and `pyproject.toml`). */
	artemisPath: "",
	/** Explicit launcher command. Empty → `uv run artemis mcp`, then `python -m mcp_server`. */
	command: "",
	/** Arguments for an explicit `command`. */
	args: [],
	/** Extra environment variables for the MCP server (for example GEMINI_API_KEY). */
	env: {},
	/** Default execution profile passed to `mobile_run_task`: "Flash" or "Pro". */
	defaultModel: "Flash",
	/** Default `device_serial`; empty → ARTEMIS picks the only ready device. */
	defaultDeviceSerial: "",
	/** Seconds `artemis_run_task` waits for the task to finish before returning `running`. */
	defaultWaitSeconds: 120,
	/** Upper bound a caller may request through `wait_seconds`. */
	maxWaitSeconds: 600,
	/** Status polling interval while waiting. */
	pollIntervalMs: 3000,
	/** Per tools/call budget (ARTEMIS itself caps diagnosis at ~40 s). */
	callTimeoutMs: 120000,
	/** Budget for the first handshake; `uv run` may resolve a venv on a cold cache. */
	startupTimeoutMs: 180000,
	/** Register the bundled playbook on `ctx.skills` when the profile mounts skills. */
	provideSkill: true,
});

/**
 * Coerce a value to a positive integer inside a range.
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when `value` is not a usable number.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped integer.
 */
function intInRange(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

/**
 * Resolve the ARTEMIS checkout: explicit config first, then `ARTEMIS_HOME`.
 * @param {unknown} value - raw `artemisPath` config value.
 * @returns {string} an absolute-ish path, or "" when unconfigured.
 */
function resolveArtemisPath(value) {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	const fromEnv = process.env.ARTEMIS_HOME;
	return typeof fromEnv === "string" ? fromEnv.trim() : "";
}

/**
 * Resolve raw plugin config into the shape the rest of the plugin consumes.
 * @param {object | undefined} raw - config from `cordis.patch.yml` or the settings page.
 * @returns {{config: object, warnings: string[]}} resolved config plus human-readable complaints.
 */
export function resolveConfig(raw) {
	const input = raw !== null && typeof raw === "object" ? raw : {};
	/** @type {string[]} */
	const warnings = [];
	const model = typeof input.defaultModel === "string" ? input.defaultModel.trim() : "";
	const normalizedModel = model.toLowerCase() === "pro" ? "Pro" : "Flash";
	if (model !== "" && model.toLowerCase() !== "flash" && model.toLowerCase() !== "pro") {
		warnings.push(`defaultModel "${model}" is not Flash or Pro; using Flash.`);
	}
	const args = Array.isArray(input.args) ? input.args.filter((v) => typeof v === "string") : [];
	if (Array.isArray(input.args) && args.length !== input.args.length) {
		warnings.push("args must be an array of strings; non-string entries were dropped.");
	}
	const env = {};
	if (input.env !== null && typeof input.env === "object" && !Array.isArray(input.env)) {
		for (const [key, value] of Object.entries(input.env)) {
			if (typeof value === "string") env[key] = value;
		}
	} else if (input.env !== undefined) {
		warnings.push("env must be an object of string values; it was ignored.");
	}
	/** @type {object} */
	const config = {
		artemisPath: resolveArtemisPath(input.artemisPath),
		command: typeof input.command === "string" ? input.command.trim() : DEFAULTS.command,
		args,
		env,
		defaultModel: normalizedModel,
		defaultDeviceSerial:
			typeof input.defaultDeviceSerial === "string" ? input.defaultDeviceSerial.trim() : "",
		defaultWaitSeconds: intInRange(input.defaultWaitSeconds, DEFAULTS.defaultWaitSeconds, 0, DEFAULTS.maxWaitSeconds),
		maxWaitSeconds: intInRange(input.maxWaitSeconds, DEFAULTS.maxWaitSeconds, 0, 7200),
		pollIntervalMs: intInRange(input.pollIntervalMs, DEFAULTS.pollIntervalMs, 500, 60000),
		callTimeoutMs: intInRange(input.callTimeoutMs, DEFAULTS.callTimeoutMs, 5000, 1800000),
		startupTimeoutMs: intInRange(input.startupTimeoutMs, DEFAULTS.startupTimeoutMs, 5000, 1800000),
		provideSkill: input.provideSkill !== false,
	};
	if (config.command !== "" && config.args.length === 0) {
		warnings.push(
			"command is set without args; the plugin will spawn it as-is, so it must start the ARTEMIS MCP server on stdio.",
		);
	}
	return { config, warnings };
}
