/**
 * tools.js — the five model-facing tools.
 *
 * Each ARTEMIS MCP tool becomes one DSH tool with a hand-written description,
 * plus the waiting behaviour a tool-calling agent needs: `artemis_run_task`
 * polls to completion inside a single call instead of asking the model to
 * babysit a trace id.
 *
 * @module dsh-plugin-artemis/lib/tools
 */

import { readFile } from "node:fs/promises";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { localChecks, localNextSteps } from "./doctor.js";
import { renderDeviceState, renderDoctor, renderRunTask, renderTask, renderTrace, screenshotPath } from "./render.js";

/** A permissive output schema: the renderers define what the model actually sees. */
const OUTPUT = { schema: { type: "object", additionalProperties: true } };

/**
 * Clamp a requested wait into `[0, maxWaitSeconds]`.
 * @param {unknown} requested - caller value.
 * @param {number} fallback - config default.
 * @param {number} max - config cap.
 * @returns {number} effective wait in seconds.
 */
function waitSeconds(requested, fallback, max) {
	if (typeof requested !== "number" || !Number.isFinite(requested)) return fallback;
	return Math.max(0, Math.min(Math.round(requested), max));
}

/**
 * Store image bytes in the DSH attachment store, when the profile mounts one.
 * @param {object} ctx - plugin context.
 * @param {Buffer} data - image bytes.
 * @param {string} name - attachment file name.
 * @param {string} mediaType - MIME type.
 * @returns {Promise<object | null>} attachment reference or null.
 */
async function attachImage(ctx, data, name, mediaType) {
	const attachments = ctx.get("attachments");
	if (attachments === undefined || attachments === null) return null;
	const ref = await attachments.saveImage({ data, mediaType, name });
	return {
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
	};
}

/**
 * Read a `file://` image ARTEMIS wrote on the device host.
 * @param {string} uri - file URI.
 * @returns {Promise<{path: string, data: Buffer}>} the decoded path and bytes.
 */
async function readImage(uri) {
	const path = screenshotPath(uri);
	const data = await readFile(path);
	return { path, data };
}

/**
 * Register every artemis_* tool.
 * @param {object} ctx - plugin context.
 * @param {{service: object, getConfig: () => object}} deps - service and live config.
 */
export function registerArtemisTools(ctx, deps) {
	const { service, getConfig } = deps;

	ctx.tools.register(
		defineTool({
			name: "artemis_run_task",
			description:
				"Run a natural-language task on a real Android device through Google ARTEMIS, a dedicated mobile-automation agent (screenshots + accessibility tree + OCR, its own planner). Use it for multi-step phone work — navigating apps, filling flows, checking a screen across several taps, reproducing a bug — instead of driving adb tap-by-tap. This call starts the task AND waits for it: it returns when the task finishes, or with status \"running\" plus a trace_id when the wait budget runs out (then collect it with artemis_task, do not start it again). Model choice: \"Flash\" (default) for deterministic single-path tasks, quickest per step; \"Pro\" for exploratory or multi-branch work, long flows, checkpoints, written output, or adb/log diagnosis. The task description is executed once, so make it self-contained: say which app, what to do, and how to tell it succeeded.",
			parameters: {
				task: {
					type: "string",
					required: true,
					description:
						"Self-contained task description: the app, the exact goal, and the condition that means success. Example: 'Open Settings, go to Battery, and report the current battery percentage.'",
				},
				model: {
					type: "string",
					enum: ["Flash", "Pro"],
					description: "Execution profile. Flash (default) is fast and reactive; Pro plans, verifies checkpoints and can write a report. Omit to use the plugin default.",
				},
				device_serial: {
					type: "string",
					description: "Target device serial (for example emulator-5556). Omit when a single device is attached.",
				},
				locked_app_package: {
					type: "string",
					description: "Optional package name to lock execution to, e.g. com.android.settings. ARTEMIS auto-launches it and forbids leaving it.",
				},
				expected_output_desc: {
					type: "string",
					description: "Pro only: what the written report in notes_dir must contain. Ignored for Flash.",
				},
				verification_level: {
					type: "string",
					enum: ["off", "final", "checkpoints", "strict"],
					description: "Pro only: how much the Checker audits the run. Default final.",
				},
				explorer_mode: {
					type: "string",
					enum: ["flash", "pro", "ultra"],
					description: "Pro only: perception depth of the Operator. flash is fastest, ultra is deepest.",
				},
				wait_seconds: {
					type: "integer",
					description:
						"How long to wait for completion inside this call (default from plugin config, 120s). 0 returns immediately with a trace_id. Flash tasks usually take 1-3 minutes, Pro runs longer.",
				},
			},
			output: { ...OUTPUT, render: (_args, value) => renderRunTask(value) },
			async execute(args, exec) {
				const config = getConfig();
				const requestedModel = args.model === "Pro" || args.model === "Flash" ? args.model : config.defaultModel;
				return service.runTask({
					task: args.task,
					model: requestedModel,
					deviceSerial: typeof args.device_serial === "string" && args.device_serial !== "" ? args.device_serial : config.defaultDeviceSerial,
					lockedAppPackage: args.locked_app_package,
					expectedOutputDesc: args.expected_output_desc,
					verificationLevel: args.verification_level,
					explorerMode: args.explorer_mode,
					waitSeconds: waitSeconds(args.wait_seconds, config.defaultWaitSeconds, config.maxWaitSeconds),
					signal: exec.signal,
				});
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "artemis_task",
			description:
				"Observe or control an ARTEMIS task started by artemis_run_task. action=\"status\" returns the outcome (result, error, assertion counts, progress); pass wait_seconds to block until the task finishes instead of polling. action=\"stop\" kills it and releases the device. action=\"inject_instruction\" steers a running task at its next planning step (use release_loop with a continuous monitoring task so it can finish cleanly).",
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: ["status", "stop", "inject_instruction"],
					description: "status | stop | inject_instruction",
				},
				trace_id: {
					type: "string",
					required: true,
					description: "The trace_id returned by artemis_run_task.",
				},
				instruction: {
					type: "string",
					description: "Guidance for inject_instruction, applied at the task's next step.",
				},
				release_loop: {
					type: "boolean",
					description: "With inject_instruction: explicitly allow a [Loop:continuous] monitoring task to finish.",
				},
				wait_seconds: {
					type: "integer",
					description: "With action=status: block until the task ends or this many seconds pass (default from plugin config).",
				},
			},
			output: { ...OUTPUT, render: (_args, value) => renderTask(value) },
			async execute(args, exec) {
				const config = getConfig();
				return service.manageTask({
					action: args.action,
					traceId: args.trace_id,
					instruction: args.instruction,
					releaseLoop: args.release_loop === true,
					waitSeconds: waitSeconds(args.wait_seconds, config.defaultWaitSeconds, config.maxWaitSeconds),
					signal: exec.signal,
				});
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "artemis_device_state",
			description:
				"Look at the device the way the ARTEMIS subagent does. view_type=\"hierarchy\" returns the fused accessibility + OCR element list with coordinates (cheap, text, good for checking what ARTEMIS can see); view_type=\"screenshot\" returns the actual screen as an image (use it when the hierarchy looks empty or you need visual confirmation). This is an observation tool: it does not act on the device.",
			parameters: {
				view_type: {
					type: "string",
					required: true,
					enum: ["hierarchy", "screenshot"],
					description: "hierarchy (text element list) or screenshot (image).",
				},
				device_serial: {
					type: "string",
					description: "Target device serial. Omit when a single device is attached.",
				},
			},
			output: { ...OUTPUT, render: (_args, value) => renderDeviceState(value) },
			async execute(args, exec) {
				const config = getConfig();
				const observed = await service.deviceState({
					viewType: args.view_type,
					deviceSerial: typeof args.device_serial === "string" && args.device_serial !== "" ? args.device_serial : config.defaultDeviceSerial,
					signal: exec.signal,
				});
				if (observed.view_type === "hierarchy") {
					return {
						view_type: "hierarchy",
						hierarchy: observed.hierarchy,
						character_count: observed.hierarchy?.length ?? 0,
					};
				}
				const { path, data } = await readImage(observed.uri);
				const image = await attachImage(ctx, data, "artemis-device-state.jpg", "image/jpeg");
				return {
					view_type: "screenshot",
					saved_path: path,
					bytes: data.byteLength,
					width: image?.width ?? null,
					height: image?.height ?? null,
					image,
					image_emitted: image !== null,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "artemis_trace",
			description:
				"Read an ARTEMIS task's execution record. action=\"view_summary\" gives the step-by-step chain (what the agent thought and did, Flash) or the plan plus verified checkpoints (Pro) — the cheapest way to explain why a task succeeded or failed. \"search\" finds steps by keyword or range. \"view_step_details\" replays one step exactly as the agent saw it. \"view_step_screenshots\" returns the before/after screenshots and the action overlay (where it tapped).",
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: ["view_summary", "search", "view_step_screenshots", "view_step_details"],
					description: "view_summary | search | view_step_screenshots | view_step_details",
				},
				trace_id: {
					type: "string",
					required: true,
					description: "Task identifier from artemis_run_task.",
				},
				step_number: {
					type: "integer",
					description: "1-indexed step, required for view_step_details and view_step_screenshots.",
				},
				query: {
					type: "string",
					description: "Search keywords for action=search (case-insensitive, every term matched independently).",
				},
				step_range: {
					type: "array",
					items: { type: "integer" },
					description: "Inclusive [start, end] step range for action=search.",
				},
				max_results: {
					type: "integer",
					description: "Search hit cap, default 5.",
				},
			},
			output: { ...OUTPUT, render: (_args, value) => renderTrace(value) },
			async execute(args, exec) {
				const inspected = await service.inspectTrace({
					action: args.action,
					traceId: args.trace_id,
					stepNumber: args.step_number,
					query: args.query,
					stepRange: args.step_range,
					maxResults: args.max_results,
					signal: exec.signal,
				});
				/** @type {Array<object>} */
				const images = [];
				if (
					inspected.action === "view_step_screenshots" &&
					inspected.output !== null &&
					typeof inspected.output === "object"
				) {
					const output = /** @type {Record<string, unknown>} */ (inspected.output);
					for (const key of ["before_screenshot", "action_overlay_screenshot"]) {
						const uri = output[key];
						if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
						try {
							const { path, data } = await readImage(uri);
							const ref = await attachImage(ctx, data, `artemis-step-${key}.jpg`, "image/jpeg");
							if (ref !== null) images.push(ref);
							output[`${key}_path`] = path;
						} catch {
							// A missing overlay must not sink the whole trace read.
						}
					}
				}
				return { action: inspected.action, trace_id: args.trace_id, output: inspected.output, images };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "artemis_doctor",
			description:
				"Check whether ARTEMIS can actually run on this machine: the checkout, uv/Python, adb devices, model credentials, and the MCP server handshake, merged with ARTEMIS's own mobile_diagnose report and its ordered next_steps. Call it first whenever any artemis_* tool errors, a task fails to start, or the user says ARTEMIS does not work. attempt_fix lets ARTEMIS apply its safe self-heals (regenerate corrupted adb keys, restart the adb server, install the accessibility helper). restart_server reconnects after you edit ARTEMIS's .env.",
			parameters: {
				attempt_fix: {
					type: "boolean",
					description: "Apply ARTEMIS's safe self-heals, then re-run the checks.",
				},
				device_serial: {
					type: "string",
					description: "Report on this specific device.",
				},
				launch_avd: {
					type: "string",
					description: "Boot an installed AVD in the background (returns immediately; boot takes 1-3 minutes).",
				},
				verify_credentials: {
					type: "boolean",
					description: "Also verify each configured key against its provider over the network (~12s).",
				},
				probe_device: {
					type: "boolean",
					description: "Also drive the device end to end (screenshot + hierarchy, ~20s) to prove a task could start.",
				},
				restart_server: {
					type: "boolean",
					description:
						"Kill and reconnect the ARTEMIS MCP server first. Use it after editing ARTEMIS's .env (keys are read at server startup), then re-run the diagnosis.",
				},
			},
			output: { ...OUTPUT, render: (_args, value) => renderDoctor(value) },
			async execute(args, exec) {
				const config = getConfig();
				if (args.restart_server === true) {
					service.dispose();
				}
				const local = await localChecks(config);
				const launch = service.activeLauncher;
				let artemis = null;
				let error = null;
				try {
					artemis = await service.diagnose({
						attemptFix: args.attempt_fix === true,
						deviceSerial: args.device_serial,
						launchAvd: args.launch_avd,
						verifyCredentials: args.verify_credentials === true,
						probeDevice: args.probe_device === true,
						signal: exec.signal,
					});
				} catch (failure) {
					error = failure instanceof Error ? failure.message : String(failure);
				}
				const nextSteps = [
					...(Array.isArray(artemis?.next_steps) ? artemis.next_steps : []),
					...localNextSteps(local, config),
				];
				const verdict = error === null ? (artemis?.verdict ?? "unknown") : "blocked";
				return {
					verdict,
					summary:
						error === null
							? (artemis?.summary ?? "ARTEMIS responded without a summary.")
							: "The ARTEMIS MCP server did not answer, so only local checks are available.",
					next_steps: nextSteps.length === 0 ? ["Environment looks ready: run artemis_run_task."] : nextSteps,
					launch_label: launch === null ? null : launch.label,
					launch_failures: service.launchFailures,
					local,
					artemis,
					error,
					stderr: service.client === null ? "" : service.client.stderrTail,
				};
			},
		}),
	);
}
