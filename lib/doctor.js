/**
 * doctor.js — local preflight checks that do not need a running ARTEMIS server.
 *
 * `artemis_doctor` merges these results with ARTEMIS's own `mobile_diagnose`
 * report, so a user with a broken checkout still gets actionable output even
 * when the MCP server cannot start at all.
 *
 * @module dsh-plugin-artemis/lib/doctor
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Environment variables ARTEMIS accepts as model credentials. */
export const PROVIDER_KEYS = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPEN_ROUTER_API_KEY",
	"XAI_API_KEY",
];

/**
 * Run a command with a deadline, never throwing.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string | null}>} outcome.
 */
export function runCommand(command, args, timeoutMs = 20000) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			execFile(
				command,
				args,
				{ timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
				(error, stdout, stderr) => {
					finish({
						ok: error === null,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
						error: error === null ? null : String(error.message ?? error),
					});
				},
			);
		} catch (error) {
			finish({ ok: false, stdout: "", stderr: "", error: String(error?.message ?? error) });
		}
	});
}

/**
 * Parse `adb devices -l` output into serials and their state.
 * @param {string} stdout - raw command output.
 * @returns {Array<{serial: string, state: string, model: string | null}>} attached devices.
 */
export function parseAdbDevices(stdout) {
	const devices = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("List of devices")) continue;
		if (line.startsWith("*")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2) continue;
		const [serial, state] = parts;
		const modelMatch = /model:(\S+)/.exec(line);
		devices.push({ serial, state, model: modelMatch === null ? null : modelMatch[1] });
	}
	return devices;
}

/**
 * Read which provider keys are configured, without ever returning a value.
 * @param {string} artemisPath - ARTEMIS checkout.
 * @returns {{exists: boolean, providers: string[], path: string}} presence report.
 */
export function readEnvProviders(artemisPath) {
	const envPath = join(artemisPath, ".env");
	if (artemisPath === "" || !existsSync(envPath)) return { exists: false, providers: [], path: envPath };
	let raw = "";
	try {
		raw = readFileSync(envPath, "utf8");
	} catch {
		return { exists: true, providers: [], path: envPath };
	}
	const providers = [];
	for (const key of PROVIDER_KEYS) {
		// [ \t] rather than \s: \s would eat the line break and match the next line's text.
		const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^\\r\\n]*)`, "m").exec(raw);
		if (match !== null && match[1].trim() !== "") providers.push(key);
	}
	return { exists: true, providers, path: envPath };
}

/**
 * Inspect the ARTEMIS checkout shape.
 * @param {string} artemisPath - configured path.
 * @returns {{configured: boolean, exists: boolean, hasPyproject: boolean, hasMcpServer: boolean, hasHelperApk: boolean}} layout facts.
 */
export function inspectCheckout(artemisPath) {
	if (artemisPath === "") {
		return { configured: false, exists: false, hasPyproject: false, hasMcpServer: false, hasHelperApk: false };
	}
	return {
		configured: true,
		exists: existsSync(artemisPath),
		hasPyproject: existsSync(join(artemisPath, "pyproject.toml")),
		hasMcpServer: existsSync(join(artemisPath, "mcp_server", "__init__.py")),
		hasHelperApk: existsSync(join(artemisPath, "packages", "artemis-accessibility-helper")),
	};
}

/**
 * Collect every local (server-independent) check.
 * @param {object} config - resolved plugin config.
 * @returns {Promise<{checks: Array<{name: string, ok: boolean, detail: string}>, env: object, checkout: object, devices: Array<object>}>} local report.
 */
export async function localChecks(config) {
	/** @type {Array<{name: string, ok: boolean, detail: string}>} */
	const checks = [];
	checks.push({
		name: "node",
		ok: true,
		detail: `${process.version} (${process.platform}/${process.arch})`,
	});

	const checkout = inspectCheckout(config.artemisPath);
	if (!checkout.configured) {
		checks.push({
			name: "artemisPath",
			ok: false,
			detail: "not configured — set it to your ARTEMIS checkout (the directory with mcp_server/ and pyproject.toml)",
		});
	} else {
		checks.push({
			name: "artemisPath",
			ok: checkout.exists && checkout.hasMcpServer,
			detail: `${config.artemisPath} (pyproject: ${checkout.hasPyproject ? "yes" : "no"}, mcp_server: ${checkout.hasMcpServer ? "yes" : "no"})`,
		});
	}

	const [uv, python, adb] = await Promise.all([
		runCommand("uv", ["--version"], 15000),
		runCommand(process.platform === "win32" ? "python" : "python3", ["--version"], 15000),
		runCommand("adb", ["devices", "-l"], 15000),
	]);
	checks.push({ name: "uv", ok: uv.ok, detail: uv.ok ? uv.stdout.trim() : `not available (${uv.error ?? "unknown error"})` });
	checks.push({
		name: "python",
		ok: python.ok,
		detail: python.ok ? `${python.stdout.trim()} ${python.stderr.trim()}`.trim() : `not available (${python.error ?? "unknown error"})`,
	});

	const devices = adb.ok ? parseAdbDevices(adb.stdout) : [];
	const ready = devices.filter((device) => device.state === "device");
	checks.push({
		name: "adb",
		ok: ready.length > 0,
		detail: adb.ok
			? ready.length === 0
				? `no authorized device (${devices.length} attached)`
				: ready.map((device) => `${device.serial}${device.model === null ? "" : ` (${device.model})`}`).join(", ")
			: `adb not available (${adb.error ?? "unknown error"})`,
	});

	const env = readEnvProviders(config.artemisPath);
	checks.push({
		name: "credentials",
		ok: env.providers.length > 0,
		detail:
			env.providers.length > 0
				? `configured: ${env.providers.join(", ")}`
				: env.exists
					? `no provider key with a value in ${env.path}`
					: `no .env at ${env.path} (copy .env.example and add a key)`,
	});

	return { checks, env, checkout, devices };
}

/**
 * Turn local findings into next-step lines the model may act on.
 * @param {object} local - report from {@link localChecks}.
 * @param {object} config - resolved plugin config.
 * @returns {string[]} ordered guidance.
 */
export function localNextSteps(local, config) {
	const steps = [];
	const byName = new Map(local.checks.map((check) => [check.name, check]));
	if (byName.get("artemisPath")?.ok !== true) {
		steps.push(
			config.artemisPath === ""
				? "Set the plugin config `artemisPath` to your ARTEMIS checkout, then re-run artemis_doctor."
				: `The configured artemisPath does not look like an ARTEMIS checkout: ${config.artemisPath}`,
		);
	}
	if (byName.get("uv")?.ok !== true && byName.get("python")?.ok !== true) {
		steps.push("Install uv (https://docs.astral.sh/uv/) or Python 3.12+, then re-run artemis_doctor.");
	}
	if (byName.get("adb")?.ok !== true) {
		steps.push(
			"Connect a device with USB debugging enabled or boot an emulator, then confirm it appears in `adb devices -l`.",
		);
	}
	if (byName.get("credentials")?.ok !== true) {
		steps.push(
			"Add a model key to the ARTEMIS `.env` (for example GEMINI_API_KEY=...) or pass it through the plugin config `env`. The MCP server reads keys at startup.",
		);
	}
	return steps;
}
