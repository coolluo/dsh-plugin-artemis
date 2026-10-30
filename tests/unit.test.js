import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpError, normalizeToolResult, splitLines } from "../lib/mcp-client.js";
import { fileUriToPath, launcherCandidates, summarizeStatus, TERMINAL_STATUSES } from "../lib/artemis.js";
import { resolveConfig } from "../lib/config.js";
import { parseAdbDevices, readEnvProviders } from "../lib/doctor.js";

test("splitLines keeps the unfinished tail", () => {
	const first = splitLines('{"a":1}\n{"b":2}\n{"c"');
	assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
	assert.equal(first.rest, '{"c"');
	const second = splitLines(`${first.rest}:3}\n`);
	assert.deepEqual(second.lines, ['{"c":3}']);
	assert.equal(second.rest, "");
});

test("splitLines tolerates CRLF and empty lines", () => {
	const split = splitLines('{"a":1}\r\n\r\n{"b":2}\r\n');
	assert.deepEqual(split.lines, ['{"a":1}', "", '{"b":2}']);
});

test("normalizeToolResult parses a JSON object payload", () => {
	const result = normalizeToolResult({
		content: [{ type: "text", text: JSON.stringify({ trace_id: "t1", status: "completed", result: "53%" }) }],
	});
	assert.equal(result.json.trace_id, "t1");
	assert.equal(result.isError, false);
	assert.deepEqual(result.images, []);
});

test("normalizeToolResult keeps plain text and flags isError", () => {
	const result = normalizeToolResult({ content: [{ type: "text", text: "Error: boom" }], isError: true });
	assert.equal(result.json, null);
	assert.equal(result.text, "Error: boom");
	assert.equal(result.isError, true);
});

test("normalizeToolResult survives a missing content array", () => {
	const result = normalizeToolResult(null);
	assert.equal(result.text, "");
	assert.equal(result.json, null);
	assert.deepEqual(result.images, []);
	assert.equal(result.isError, false);
});

test("fileUriToPath handles Windows and POSIX URIs", () => {
	assert.equal(fileUriToPath("file://C:\\artemis\\live_screenshot.jpg"), "C:\\artemis\\live_screenshot.jpg");
	assert.equal(fileUriToPath("file:///tmp/live.jpg"), "/tmp/live.jpg");
	assert.equal(fileUriToPath("file://C:\\a%20b\\shot.jpg"), "C:\\a b\\shot.jpg");
});

test("launcherCandidates prefers uv inside a configured checkout", () => {
	const candidates = launcherCandidates({ artemisPath: "C:\\work\\artemis", command: "", args: [] });
	assert.equal(candidates[0].command, "uv");
	assert.deepEqual(candidates[0].args, ["run", "artemis", "mcp"]);
	assert.equal(candidates[0].cwd, "C:\\work\\artemis");
	assert.ok(candidates.some((candidate) => candidate.args.includes("mcp_server")));
});

test("launcherCandidates honours an explicit command", () => {
	const candidates = launcherCandidates({
		artemisPath: "C:\\work\\artemis",
		command: "C:\\venv\\python.exe",
		args: ["-m", "mcp_server"],
	});
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].command, "C:\\venv\\python.exe");
	assert.equal(candidates[0].cwd, "C:\\work\\artemis");
});

test("summarizeStatus keeps the fields the tools promise", () => {
	const summary = summarizeStatus({
		trace_id: "abc",
		status: "completed",
		device_serial: "emulator-5556",
		elapsed_seconds: 42.5,
		result: "53%",
		test_summary: { passed: 2, failed: 0 },
		progress: { phase: "done" },
		unknown_field: "ignored",
	});
	assert.equal(summary.trace_id, "abc");
	assert.equal(summary.status, "completed");
	assert.equal(summary.elapsed_seconds, 42.5);
	assert.equal(summary.result, "53%");
	assert.equal("unknown_field" in summary, false);
});

test("terminal statuses cover every stop condition", () => {
	for (const status of ["completed", "failed", "cancelled", "unknown"]) {
		assert.equal(TERMINAL_STATUSES.has(status), true);
	}
	for (const status of ["running", "pending"]) {
		assert.equal(TERMINAL_STATUSES.has(status), false);
	}
});

test("resolveConfig fills defaults and reports bad values", () => {
	const { config, warnings } = resolveConfig({ defaultModel: "turbo", defaultWaitSeconds: 999999, env: { A: 1 } });
	assert.equal(config.defaultModel, "Flash");
	assert.equal(config.defaultWaitSeconds, 600);
	assert.equal(config.pollIntervalMs, 3000);
	assert.deepEqual(config.env, {});
	assert.equal(warnings.length, 1);
});

test("resolveConfig keeps valid input", () => {
	const { config, warnings } = resolveConfig({
		artemisPath: " C:\\work\\artemis ",
		defaultModel: "pro",
		defaultWaitSeconds: 30,
		env: { GEMINI_API_KEY: "x" },
		provideSkill: false,
	});
	assert.equal(config.artemisPath, "C:\\work\\artemis");
	assert.equal(config.defaultModel, "Pro");
	assert.equal(config.defaultWaitSeconds, 30);
	assert.deepEqual(config.env, { GEMINI_API_KEY: "x" });
	assert.equal(config.provideSkill, false);
	assert.deepEqual(warnings, []);
});

test("parseAdbDevices reads serials, states and models", () => {
	const devices = parseAdbDevices(
		[
			"List of devices attached",
			"emulator-5556          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
			"R58M123456A            unauthorized usb:1-1",
			"",
		].join("\n"),
	);
	assert.equal(devices.length, 2);
	assert.deepEqual(devices[0], { serial: "emulator-5556", state: "device", model: "sdk_gphone64_x86_64" });
	assert.equal(devices[1].state, "unauthorized");
	assert.equal(devices[1].model, null);
});

test("readEnvProviders only counts keys that actually have a value", () => {
	const dir = mkdtempSync(join(tmpdir(), "artemis-env-"));
	writeFileSync(
		join(dir, ".env"),
		[
			"# copy .env.example and fill in",
			"GEMINI_API_KEY=",
			"OPENAI_API_KEY=sk-test-value",
			"ANTHROPIC_API_KEY=   ",
			"XAI_API_KEY=\"quoted\"",
			"",
		].join("\r\n"),
	);
	const report = readEnvProviders(dir);
	assert.equal(report.exists, true);
	assert.deepEqual(report.providers, ["OPENAI_API_KEY", "XAI_API_KEY"]);
});

test("readEnvProviders tolerates a missing checkout", () => {
	const report = readEnvProviders("C:\\definitely\\not\\here");
	assert.equal(report.exists, false);
	assert.deepEqual(report.providers, []);
});

test("McpError carries a machine code", () => {
	const error = new McpError("nope", { code: "TIMEOUT" });
	assert.equal(error.code, "TIMEOUT");
	assert.equal(error.message, "nope");
});
