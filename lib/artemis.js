/**
 * artemis.js — the ARTEMIS MCP server as a DSH-side service.
 *
 * Owns the connection, picks a launcher, and turns ARTEMIS's asynchronous task
 * model into something a tool-calling agent can use in one step: `runTask`
 * starts a task and then polls `mobile_manage_task` until it is terminal (or a
 * caller-supplied deadline passes), so the model does not have to burn turns
 * on polling.
 *
 * @module dsh-plugin-artemis/lib/artemis
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { McpError, McpStdioClient } from "./mcp-client.js";

/** Statuses after which a task will never change again. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "unknown"]);

/**
 * Turn a `file://` URI returned by ARTEMIS into a filesystem path.
 * Windows URIs arrive as `file://C:\dir\x.jpg`; POSIX ones as `file:///dir/x.jpg`.
 * @param {string} uri - the URI returned by `mobile_get_device_state`.
 * @returns {string} a path usable with `node:fs`.
 */
export function fileUriToPath(uri) {
	let path = uri.trim();
	if (path.startsWith("file://")) path = path.slice("file://".length);
	try {
		path = decodeURI(path);
	} catch {
		// Not percent-encoded; use it verbatim.
	}
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	return path;
}

/**
 * Sleep that can be cancelled.
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @returns {Promise<void>} resolves after the delay or rejects with an abort error.
 */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new McpError("cancelled", { code: "ABORTED" }));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		if (typeof timer.unref === "function") timer.unref();
		const onAbort = () => {
			clearTimeout(timer);
			reject(new McpError("cancelled", { code: "ABORTED" }));
		};
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/**
 * Build the launcher candidates in preference order.
 *
 * An explicit `command` wins; otherwise a configured checkout is driven through
 * `uv run artemis mcp` (which creates the venv on first use) with a direct
 * `python -m mcp_server` fallback, and an unconfigured install falls back to a
 * globally installed `artemis` CLI.
 *
 * @param {object} config - resolved plugin config.
 * @returns {Array<{command: string, args: string[], cwd?: string, label: string}>} candidates.
 */
export function launcherCandidates(config) {
	if (config.command !== "") {
		return [
			{
				command: config.command,
				args: config.args,
				cwd: config.artemisPath === "" ? undefined : config.artemisPath,
				label: `${config.command} ${config.args.join(" ")}`.trim(),
			},
		];
	}
	/** @type {Array<{command: string, args: string[], cwd?: string, label: string}>} */
	const candidates = [];
	if (config.artemisPath !== "") {
		// An existing venv is the fastest and most predictable launcher: no uv
		// cache, no environment resolution, and it is what `uv sync` produced.
		const venvPython =
			process.platform === "win32"
				? join(config.artemisPath, ".venv", "Scripts", "python.exe")
				: join(config.artemisPath, ".venv", "bin", "python");
		if (existsSync(venvPython)) {
			candidates.push({ command: venvPython, args: ["-m", "mcp_server"], cwd: config.artemisPath, label: "venv python -m mcp_server" });
		}
		candidates.push(
			{ command: "uv", args: ["run", "artemis", "mcp"], cwd: config.artemisPath, label: "uv run artemis mcp" },
			{ command: "python", args: ["-m", "mcp_server"], cwd: config.artemisPath, label: "python -m mcp_server" },
			{ command: "python3", args: ["-m", "mcp_server"], cwd: config.artemisPath, label: "python3 -m mcp_server" },
		);
		return candidates;
	}
	candidates.push(
		{ command: "artemis", args: ["mcp"], label: "artemis mcp" },
		{ command: "uv", args: ["run", "artemis", "mcp"], label: "uv run artemis mcp" },
	);
	return candidates;
}

/** Client-side view over one ARTEMIS MCP server. */
export class ArtemisService {
	/**
	 * @param {object} options - service options.
	 * @param {object} options.config - resolved plugin config.
	 * @param {{info?: Function, warn?: Function, debug?: Function}} [options.logger] - logger.
	 */
	constructor(options) {
		this.config = options.config;
		this.logger = options.logger;
		/** @type {McpStdioClient | null} */
		this.client = null;
		/** @type {{command: string, args: string[], cwd?: string, label: string} | null} */
		this.launch = null;
		/** @type {Array<{label: string, error: string, stderr: string}>} */
		this.launchFailures = [];
	}

	/** The launcher that is currently in use, if connected. */
	get activeLauncher() {
		return this.launch;
	}

	/**
	 * Ensure a live server, trying each launcher candidate once.
	 * @param {AbortSignal} [signal] - cancellation signal.
	 * @returns {Promise<McpStdioClient>} the connected client.
	 */
	async ensureClient(signal) {
		if (this.client?.running === true) return this.client;
		this.launchFailures = [];
		for (const candidate of launcherCandidates(this.config)) {
			if (signal?.aborted === true) throw new McpError("cancelled", { code: "ABORTED" });
			const client = new McpStdioClient({
				command: candidate.command,
				args: candidate.args,
				cwd: candidate.cwd,
				env: this.config.env,
				startupTimeoutMs: this.config.startupTimeoutMs,
				logger: this.logger,
			});
			try {
				await client.start();
				this.client = client;
				this.launch = candidate;
				this.logger?.info?.(`connected to ARTEMIS MCP server via ${candidate.label}`);
				return client;
			} catch (error) {
				this.launchFailures.push({
					label: candidate.label,
					error: error instanceof Error ? error.message : String(error),
					stderr: client.stderrTail,
				});
				client.close();
			}
		}
		const tried = this.launchFailures.map((failure) => `  - ${failure.label}: ${failure.error}`).join("\n");
		throw new McpError(
			`could not start the ARTEMIS MCP server. Tried:\n${tried}\n` +
				"Set the plugin config `artemisPath` to your ARTEMIS checkout (the directory holding mcp_server/ and pyproject.toml), then call artemis_doctor.",
			{ code: "NO_LAUNCHER" },
		);
	}

	/**
	 * Call one ARTEMIS tool and normalize transport failures into actionable errors.
	 * @param {string} tool - MCP tool name.
	 * @param {object} args - tool arguments.
	 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cancellation and timeout.
	 * @returns {Promise<{text: string, json: unknown, images: Array<{data: string, mimeType?: string}>, isError: boolean}>} result.
	 */
	async call(tool, args, options = {}) {
		const client = await this.ensureClient(options.signal);
		try {
			return await client.callTool(tool, args, {
				signal: options.signal,
				timeoutMs: options.timeoutMs ?? this.config.callTimeoutMs,
			});
		} catch (error) {
			if (error instanceof McpError && error.code === "ABORTED") throw error;
			const stderr = client.stderrTail.trim();
			const detail = error instanceof Error ? error.message : String(error);
			throw new McpError(
				`${tool} failed: ${detail}${stderr === "" ? "" : `\nARTEMIS stderr tail:\n${stderr}`}`,
				{ code: "TOOL_FAILED", cause: error },
			);
		}
	}

	/**
	 * Read a task status through `mobile_manage_task`.
	 * @param {string} traceId - task identifier.
	 * @param {{signal?: AbortSignal}} [options] - cancellation.
	 * @returns {Promise<object>} the status object.
	 */
	async taskStatus(traceId, options = {}) {
		const result = await this.call("mobile_manage_task", { action: "status", trace_id: traceId }, options);
		if (result.json === null) {
			throw new McpError(`mobile_manage_task returned a non-JSON status: ${result.text.slice(0, 400)}`);
		}
		return /** @type {object} */ (result.json);
	}

	/**
	 * Poll a task until it reaches a terminal status or the deadline passes.
	 * @param {string} traceId - task identifier.
	 * @param {object} options - polling options.
	 * @param {number} options.waitSeconds - how long to wait; 0 returns after one poll.
	 * @param {AbortSignal} [options.signal] - cancellation.
	 * @param {(status: object) => void} [options.onTick] - progress callback.
	 * @returns {Promise<{status: object, waited_ms: number, timed_out: boolean}>} final observation.
	 */
	async pollTask(traceId, options) {
		const started = Date.now();
		const budgetMs = Math.max(0, options.waitSeconds) * 1000;
		const deadline = started + budgetMs;
		let status = await this.taskStatus(traceId, { signal: options.signal });
		options.onTick?.(status);
		while (!TERMINAL_STATUSES.has(String(status.status))) {
			if (Date.now() >= deadline) {
				return { status, waited_ms: Date.now() - started, timed_out: true };
			}
			await delay(Math.min(this.config.pollIntervalMs, deadline - Date.now()), options.signal);
			status = await this.taskStatus(traceId, { signal: options.signal });
			options.onTick?.(status);
		}
		return { status, waited_ms: Date.now() - started, timed_out: false };
	}

	/**
	 * Start a task and wait for it inside the same tool call.
	 * @param {object} args - run arguments.
	 * @param {string} args.task - self-contained task description.
	 * @param {"Flash" | "Pro"} args.model - execution profile.
	 * @param {string} [args.deviceSerial] - target device serial.
	 * @param {string} [args.lockedAppPackage] - package the agent must stay inside.
	 * @param {string} [args.expectedOutputDesc] - Pro-only written report request.
	 * @param {string} [args.verificationLevel] - Pro checker preset.
	 * @param {string} [args.explorerMode] - Pro explorer perception tier.
	 * @param {number} args.waitSeconds - wait budget.
	 * @param {AbortSignal} [args.signal] - cancellation.
	 * @returns {Promise<object>} combined run + final status.
	 */
	async runTask(args) {
		const request = {
			task_desc: args.task,
			model: args.model,
		};
		if (args.deviceSerial !== undefined && args.deviceSerial !== "") request.device_serial = args.deviceSerial;
		if (args.lockedAppPackage !== undefined && args.lockedAppPackage !== "") {
			request.locked_app_package = args.lockedAppPackage;
		}
		if (args.expectedOutputDesc !== undefined && args.expectedOutputDesc !== "") {
			request.expected_output_desc = args.expectedOutputDesc;
		}
		if (args.verificationLevel !== undefined && args.verificationLevel !== "") {
			request.verification_level = args.verificationLevel;
		}
		if (args.explorerMode !== undefined && args.explorerMode !== "") {
			request.explorer_mode = args.explorerMode;
		}

		const started = await this.call("mobile_run_task", request, { signal: args.signal });
		const startedJson = /** @type {object} */ (started.json ?? {});
		const traceId = typeof startedJson.trace_id === "string" ? startedJson.trace_id : "";
		if (traceId === "") {
			return {
				trace_id: "",
				status: "failed",
				model: args.model,
				error: `mobile_run_task returned no trace_id: ${started.text.slice(0, 500)}`,
				message: "The task was not started.",
			};
		}

		const base = {
			trace_id: traceId,
			model: args.model,
			device_serial: typeof startedJson.device_serial === "string" ? startedJson.device_serial : null,
			stdout_log: typeof startedJson.stdout_log === "string" ? startedJson.stdout_log : null,
			stderr_log: typeof startedJson.stderr_log === "string" ? startedJson.stderr_log : null,
			notes_dir: typeof startedJson.notes_dir === "string" ? startedJson.notes_dir : null,
			message: typeof startedJson.message === "string" ? startedJson.message : null,
		};

		if (startedJson.status === "failed") {
			return {
				...base,
				status: "failed",
				error: typeof startedJson.error === "string" ? startedJson.error : null,
			};
		}

		const polled = await this.pollTask(traceId, {
			waitSeconds: args.waitSeconds,
			signal: args.signal,
		});
		return { ...mergeKeepingBase(base, summarizeStatus(polled.status)), wait_seconds: args.waitSeconds, timed_out: polled.timed_out, waited_ms: polled.waited_ms };
	}

	/**
	 * Manage a task (status / stop / inject) with optional waiting.
	 * @param {object} args - arguments.
	 * @param {"status" | "stop" | "inject_instruction"} args.action - lifecycle action.
	 * @param {string} args.traceId - task identifier.
	 * @param {string} [args.instruction] - guidance for inject_instruction.
	 * @param {boolean} [args.releaseLoop] - end a continuous monitoring loop.
	 * @param {number} args.waitSeconds - wait budget for action=status.
	 * @param {AbortSignal} [args.signal] - cancellation.
	 * @returns {Promise<object>} the ARTEMIS status object plus waiting metadata.
	 */
	async manageTask(args) {
		if (args.action === "status") {
			const polled = await this.pollTask(args.traceId, { waitSeconds: args.waitSeconds, signal: args.signal });
			return { ...summarizeStatus(polled.status), action: "status", timed_out: polled.timed_out, waited_ms: polled.waited_ms };
		}
		const request = { action: args.action, trace_id: args.traceId };
		if (args.instruction !== undefined && args.instruction !== "") request.instruction = args.instruction;
		if (args.releaseLoop === true) request.release_loop = true;
		const result = await this.call("mobile_manage_task", request, { signal: args.signal });
		return { ...(/** @type {object} */ (result.json ?? {})), action: args.action };
	}

	/**
	 * Observe the device: a screenshot URI or the fused UI hierarchy text.
	 * @param {object} args - arguments.
	 * @param {"screenshot" | "hierarchy"} args.viewType - observation kind.
	 * @param {string} [args.deviceSerial] - target device.
	 * @param {AbortSignal} [args.signal] - cancellation.
	 * @returns {Promise<{view_type: string, uri: string | null, hierarchy: string | null, raw: string}>} observation.
	 */
	async deviceState(args) {
		const request = { view_type: args.viewType };
		if (args.deviceSerial !== undefined && args.deviceSerial !== "") request.device_serial = args.deviceSerial;
		const result = await this.call("mobile_get_device_state", request, { signal: args.signal });
		const text = result.text.trim();
		if (args.viewType === "screenshot") {
			if (!text.startsWith("file://")) {
				throw new McpError(`mobile_get_device_state did not return a file URI: ${text.slice(0, 300)}`);
			}
			return { view_type: "screenshot", uri: text, hierarchy: null, raw: text };
		}
		return { view_type: "hierarchy", uri: null, hierarchy: text, raw: text };
	}

	/**
	 * Inspect a trace: summary, search, per-step details, or screenshots.
	 * @param {object} args - arguments.
	 * @param {string} args.action - one of the four inspect actions.
	 * @param {string} args.traceId - task identifier.
	 * @param {number} [args.stepNumber] - 1-indexed step.
	 * @param {string} [args.query] - search keywords.
	 * @param {number[]} [args.stepRange] - inclusive [start, end] range.
	 * @param {number} [args.maxResults] - search hit cap.
	 * @param {AbortSignal} [args.signal] - cancellation.
	 * @returns {Promise<{action: string, output: unknown}>} the raw payload.
	 */
	async inspectTrace(args) {
		const request = { action: args.action, trace_id: args.traceId };
		if (typeof args.stepNumber === "number") request.step_number = args.stepNumber;
		if (typeof args.query === "string" && args.query !== "") request.query = args.query;
		if (Array.isArray(args.stepRange)) request.step_range = args.stepRange;
		if (typeof args.maxResults === "number") request.max_results = args.maxResults;
		const result = await this.call("mobile_inspect_trace", request, { signal: args.signal });
		return { action: args.action, output: result.json ?? result.text };
	}

	/**
	 * Run ARTEMIS's own readiness diagnosis.
	 * @param {object} args - arguments.
	 * @param {boolean} [args.attemptFix] - apply ARTEMIS safe self-heals.
	 * @param {string} [args.deviceSerial] - device to report on.
	 * @param {string} [args.launchAvd] - boot an installed AVD in the background.
	 * @param {boolean} [args.verifyCredentials] - live key verification (~12 s).
	 * @param {boolean} [args.probeDevice] - end-to-end device smoke test (~20 s).
	 * @param {AbortSignal} [args.signal] - cancellation.
	 * @returns {Promise<object>} the diagnosis object.
	 */
	async diagnose(args) {
		const request = {};
		if (args.attemptFix === true) request.attempt_fix = true;
		if (typeof args.deviceSerial === "string" && args.deviceSerial !== "") request.device_serial = args.deviceSerial;
		if (typeof args.launchAvd === "string" && args.launchAvd !== "") request.launch_avd = args.launchAvd;
		if (args.verifyCredentials === true) request.verify_credentials = true;
		if (args.probeDevice === true) request.probe_device = true;
		const result = await this.call("mobile_diagnose", request, {
			timeoutMs: Math.max(this.config.callTimeoutMs, 120000),
			signal: args.signal,
		});
		return /** @type {object} */ (result.json ?? { verdict: "unknown", summary: result.text.slice(0, 800) });
	}

	/** Tear down the connection. */
	dispose() {
		this.client?.close();
		this.client = null;
	}
}

/**
 * Merge a later status over the launch response without letting a missing
 * status field erase a value the launch already reported (for example the log
 * paths, which `mobile_manage_task` omits on some paths).
 * @param {Record<string, unknown>} base - values from `mobile_run_task`.
 * @param {Record<string, unknown>} summary - values from the status poll.
 * @returns {Record<string, unknown>} the merged view.
 */
export function mergeKeepingBase(base, summary) {
	const merged = { ...base, ...summary };
	for (const key of Object.keys(base)) {
		if (merged[key] === null && base[key] !== null && base[key] !== undefined) merged[key] = base[key];
	}
	return merged;
}

/**
 * Flatten ARTEMIS's status object into the stable shape the tools return.
 * @param {object} status - `mobile_manage_task` status payload.
 * @returns {object} the flattened subset.
 */
export function summarizeStatus(status) {
	const summary = {
		trace_id: typeof status.trace_id === "string" ? status.trace_id : null,
		status: typeof status.status === "string" ? status.status : "unknown",
		device_serial: typeof status.device_serial === "string" ? status.device_serial : null,
		elapsed_seconds: typeof status.elapsed_seconds === "number" ? status.elapsed_seconds : null,
		task_desc: typeof status.task_desc === "string" ? status.task_desc : null,
		model: typeof status.model === "string" ? status.model : null,
		stdout_log: typeof status.stdout_log === "string" ? status.stdout_log : null,
		stderr_log: typeof status.stderr_log === "string" ? status.stderr_log : null,
		notes_dir: typeof status.notes_dir === "string" ? status.notes_dir : null,
	};
	if (status.error !== undefined && status.error !== null) summary.error = String(status.error);
	if (status.result !== undefined && status.result !== null) summary.result = status.result;
	if (status.test_summary !== undefined && status.test_summary !== null) summary.test_summary = status.test_summary;
	if (status.progress !== undefined && status.progress !== null) summary.progress = status.progress;
	if (typeof status.message === "string") summary.message = status.message;
	return summary;
}
