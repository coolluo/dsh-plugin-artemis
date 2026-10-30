/**
 * render.js — model-facing projections for the artemis_* tools.
 *
 * The tools return structured values; these renderers turn them into the text
 * blocks the model reads. Images (a device screenshot, a step overlay) are
 * emitted as separate blocks only when an attachment reference exists.
 *
 * @module dsh-plugin-artemis/lib/render
 */

import { fileUriToPath } from "./artemis.js";

/** Render a scalar as `- label: value`, skipping empty values. */
function line(label, value) {
	if (value === null || value === undefined || value === "") return null;
	return `- ${label}: ${value}`;
}

/** Join non-null lines. */
function joinLines(lines) {
	return lines.filter((value) => value !== null).join("\n");
}

/** Seconds as `12.3s`. */
function seconds(value) {
	return typeof value === "number" ? `${value.toFixed(1)}s` : null;
}

/** Pretty-print an unknown value for a text block, capped in size. */
function describe(value, cap = 4000) {
	if (value === null || value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n… (${text.length - cap} more characters truncated)`;
}

/**
 * Render `artemis_run_task`: a status header first, then the payload that
 * matters (result / error / test summary / progress / log paths).
 * @param {object} value - tool value.
 * @returns {Array<object>} blocks.
 */
export function renderRunTask(value) {
	const status = String(value.status ?? "unknown");
	const head = [`ARTEMIS task ${status.toUpperCase()} — trace \`${value.trace_id ?? "unknown"}\``];
	head.push(
		joinLines([
			line("model", value.model),
			line("device", value.device_serial),
			line("elapsed", seconds(value.elapsed_seconds)),
			line("waited", value.waited_ms === null || value.waited_ms === undefined ? null : `${Math.round(value.waited_ms / 1000)}s`),
		]),
	);
	if (value.timed_out === true) {
		head.push(
			`The task is still running after the wait budget. Call \`artemis_task\` with action "status" and this trace id to collect the outcome — do not start it again.`,
		);
	}
	const body = [];
	if (value.error !== undefined && value.error !== null) body.push(`Error: ${value.error}`);
	else if (status === "failed") {
		body.push(
			"ARTEMIS recorded no error for this failure — its preflight (missing key, bad config) prints to stdout, not to status.json. Read the stdout log below before retrying.",
		);
	}
	if (value.result !== undefined && value.result !== null) body.push(`Result: ${describe(value.result)}`);
	if (value.test_summary !== undefined && value.test_summary !== null) {
		body.push(`Assertions: ${describe(value.test_summary, 1500)}`);
	}
	if (value.progress !== undefined && value.progress !== null) {
		body.push(`Progress: ${describe(value.progress, 2000)}`);
	}
	if (typeof value.message === "string" && value.message !== "") body.push(value.message);
	const logs = joinLines([line("stdout log", value.stdout_log), line("stderr log", value.stderr_log), line("notes dir", value.notes_dir)]);
	if (logs !== null) body.push(logs);
	return [{ type: "text", text: [head.filter((part) => part !== "").join("\n"), body.join("\n\n")].filter((part) => part !== "").join("\n\n") }];
}

/**
 * Render `artemis_task`.
 * @param {object} value - tool value.
 * @returns {Array<object>} blocks.
 */
export function renderTask(value) {
	const lines = [
		`ARTEMIS task ${String(value.status ?? "unknown").toUpperCase()} — trace \`${value.trace_id ?? "unknown"}\``,
		joinLines([
			line("action", value.action),
			line("model", value.model),
			line("device", value.device_serial),
			line("elapsed", seconds(value.elapsed_seconds)),
		]),
	];
	if (value.timed_out === true) lines.push("Still running after the wait budget; poll again or stop it.");
	if (value.error !== undefined && value.error !== null) lines.push(`Error: ${value.error}`);
	else if (String(value.status) === "failed") {
		lines.push(
			"ARTEMIS recorded no error for this failure — its preflight (missing key, bad config) prints to stdout, not to status.json. Read the stdout log below.",
		);
	}
	if (value.result !== undefined && value.result !== null) lines.push(`Result: ${describe(value.result)}`);
	if (value.test_summary !== undefined && value.test_summary !== null) lines.push(`Assertions: ${describe(value.test_summary, 1500)}`);
	if (value.progress !== undefined && value.progress !== null) lines.push(`Progress: ${describe(value.progress, 2500)}`);
	if (typeof value.message === "string" && value.message !== "") lines.push(value.message);
	if (typeof value.task_desc === "string") lines.push(`Task: ${value.task_desc}`);
	const logs = joinLines([line("stdout log", value.stdout_log), line("stderr log", value.stderr_log), line("notes dir", value.notes_dir)]);
	if (logs !== null) lines.push(logs);
	return [{ type: "text", text: lines.filter((part) => part !== "").join("\n") }];
}

/**
 * Render `artemis_device_state`, emitting the screenshot as an image block when
 * an attachment was stored.
 * @param {object} value - tool value.
 * @returns {Array<object>} blocks.
 */
export function renderDeviceState(value) {
	/** @type {Array<object>} */
	const blocks = [];
	if (value.view_type === "hierarchy") {
		blocks.push({
			type: "text",
			text: `Device hierarchy (${value.character_count ?? "?"} chars) — this is what the ARTEMIS subagent sees:\n\n${value.hierarchy ?? ""}`,
		});
		return blocks;
	}
	const lines = [
		`Device screenshot${value.device_serial === null || value.device_serial === undefined ? "" : ` on ${value.device_serial}`}${value.width === undefined ? "" : ` (${value.width}x${value.height}, ${Math.round((value.bytes ?? 0) / 1024)} KB)`}.`,
		value.saved_path === null || value.saved_path === undefined ? null : `Local file: ${value.saved_path}`,
		value.image_emitted === true ? "Image emitted to model context: yes." : "Image could not be attached to the context; read it from the local file path above.",
	];
	blocks.push({ type: "text", text: lines.filter((part) => part !== null).join("\n") });
	if (value.image_emitted === true && value.image !== null && value.image !== undefined) {
		blocks.push({ type: "image", attachment: value.image });
	}
	return blocks;
}

/**
 * Render `artemis_trace`.
 * @param {object} value - tool value.
 * @returns {Array<object>} blocks.
 */
export function renderTrace(value) {
	/** @type {Array<object>} */
	const blocks = [];
	const header = `ARTEMIS trace \`${value.trace_id ?? "unknown"}\` — action ${value.action ?? "?"}`;
	if (typeof value.output === "string") {
		blocks.push({ type: "text", text: `${header}\n\n${value.output}` });
	} else {
		blocks.push({ type: "text", text: `${header}\n\n${describe(value.output) ?? "(no output)"}` });
	}
	for (const image of value.images ?? []) {
		blocks.push({ type: "image", attachment: image });
	}
	return blocks;
}

/**
 * Render `artemis_doctor`.
 * @param {object} value - tool value.
 * @returns {Array<object>} blocks.
 */
export function renderDoctor(value) {
	const lines = [`ARTEMIS environment: ${String(value.verdict ?? "unknown").toUpperCase()}`];
	if (typeof value.summary === "string") lines.push(value.summary);
	const launcher = value.launch_label ?? (value.launch === null || value.launch === undefined ? null : value.launch.command);
	if (launcher !== null) lines.push(`Launcher: ${launcher}`);
	for (const step of value.next_steps ?? []) lines.push(step);
	const local = value.local;
	if (local !== null && typeof local === "object") {
		lines.push("", "Local checks:");
		for (const check of local.checks ?? []) {
			lines.push(`  [${check.ok === true ? "ok" : "fail"}] ${check.name}: ${check.detail}`);
		}
	}
	if (typeof value.error === "string" && value.error !== "") lines.push("", `Error: ${value.error}`);
	if (typeof value.stderr === "string" && value.stderr.trim() !== "") {
		lines.push("", "ARTEMIS stderr tail:", value.stderr.trim().slice(-2000));
	}
	return [{ type: "text", text: lines.join("\n") }];
}

/**
 * Read the screenshot a `file://` URI points at, as bytes.
 * Kept here so the tool layer stays free of transport concerns.
 * @param {string} uri - `file://` URI from `mobile_get_device_state`.
 * @returns {string} the decoded filesystem path.
 */
export function screenshotPath(uri) {
	return fileUriToPath(uri);
}
