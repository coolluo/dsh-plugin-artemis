import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ArtemisService } from "../lib/artemis.js";
import { resolveConfig } from "../lib/config.js";

const mockServer = fileURLToPath(new URL("./mock-mcp-server.js", import.meta.url));

/**
 * Build a service whose launcher is the mock MCP server process.
 * @param {object} [overrides] - config overrides.
 * @returns {ArtemisService} a ready-to-use service.
 */
function makeService(overrides = {}) {
	const { config } = resolveConfig({
		command: process.execPath,
		args: [mockServer],
		pollIntervalMs: 500,
		defaultWaitSeconds: 10,
		...overrides,
	});
	return new ArtemisService({ config });
}

test("handshake exposes the five ARTEMIS tools", async () => {
	const service = makeService();
	try {
		const client = await service.ensureClient();
		const tools = await client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name).sort(),
			["mobile_diagnose", "mobile_get_device_state", "mobile_inspect_trace", "mobile_manage_task", "mobile_run_task"],
		);
		assert.equal(service.activeLauncher.command, process.execPath);
	} finally {
		service.dispose();
	}
});

test("runTask starts the task, polls, and returns the final status", async () => {
	const service = makeService();
	try {
		const result = await service.runTask({ task: "read the battery level", model: "Flash", waitSeconds: 10 });
		assert.equal(result.trace_id, "mock-trace-1");
		assert.equal(result.status, "completed");
		assert.equal(result.timed_out, false);
		assert.equal(result.result, "Battery 100 percent");
		assert.equal(result.elapsed_seconds, 42.5);
		assert.equal(result.stdout_log, "C:\\mock\\stdout.log");
	} finally {
		service.dispose();
	}
});

test("runTask reports still-running when the wait budget expires", async () => {
	const service = makeService({ pollIntervalMs: 500 });
	try {
		const result = await service.runTask({ task: "long task", model: "Flash", waitSeconds: 0 });
		assert.equal(result.status, "running");
		assert.equal(result.timed_out, true);
	} finally {
		service.dispose();
	}
});

test("runTask propagates cancellation through exec.signal", async () => {
	const service = makeService({ pollIntervalMs: 5000 });
	const controller = new AbortController();
	try {
		const promise = service.runTask({ task: "cancel me", model: "Flash", waitSeconds: 30, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(promise, /cancelled|cancel/i);
	} finally {
		service.dispose();
	}
});

test("deviceState returns a URI for screenshots and text for hierarchy", async () => {
	const dir = mkdtempSync(join(tmpdir(), "artemis-mock-"));
	process.env.MOCK_SCREENSHOT_DIR = dir;
	const service = makeService();
	try {
		const screenshot = await service.deviceState({ viewType: "screenshot" });
		assert.match(String(screenshot.uri), /^file:\/\//);
		const { fileUriToPath } = await import("../lib/artemis.js");
		const path = fileUriToPath(screenshot.uri);
		assert.equal(existsSync(path), true);
		assert.ok(path.startsWith(dir));

		const hierarchy = await service.deviceState({ viewType: "hierarchy" });
		assert.equal(hierarchy.uri, null);
		assert.match(hierarchy.hierarchy, /Battery/);
	} finally {
		service.dispose();
		delete process.env.MOCK_SCREENSHOT_DIR;
	}
});

test("diagnose passes ARTEMIS's verdict through", async () => {
	const service = makeService();
	try {
		const diagnosis = await service.diagnose({});
		assert.equal(diagnosis.verdict, "ready");
		assert.equal(Array.isArray(diagnosis.next_steps), true);
	} finally {
		service.dispose();
	}
});

test("dispose then reuse reconnects a fresh server process", async () => {
	const service = makeService();
	try {
		const first = await service.diagnose({});
		assert.equal(first.verdict, "ready");
		service.dispose();
		const second = await service.diagnose({});
		assert.equal(second.verdict, "ready");
	} finally {
		service.dispose();
	}
});

test("a request that outlives callTimeoutMs fails as a timeout", async () => {
	process.env.MOCK_SLOW = "1";
	const service = makeService({ callTimeoutMs: 5000 });
	try {
		// callTimeoutMs is clamped to >= 5000, so shrink the per-call budget directly.
		service.config.callTimeoutMs = 500;
		await assert.rejects(service.inspectTrace({ action: "view_summary", traceId: "x" }), /timed out/i);
	} finally {
		service.dispose();
		delete process.env.MOCK_SLOW;
	}
});

test("a crashed server is respawned on the next call", async () => {
	const service = makeService();
	try {
		await assert.rejects(service.inspectTrace({ action: "crash", traceId: "x" }), /exited|closed|ERR|EPIPE|socket/i);
		const diagnosis = await service.diagnose({});
		assert.equal(diagnosis.verdict, "ready");
	} finally {
		service.dispose();
	}
});

test("a missing launcher reports every candidate that failed", async () => {
	const { config } = resolveConfig({ artemisPath: "C:\\definitely\\not\\here" });
	const service = new ArtemisService({ config });
	try {
		await service.ensureClient();
		assert.fail("expected the service to refuse to start");
	} catch (error) {
		assert.match(String(error.message), /could not start the ARTEMIS MCP server/);
		assert.match(String(error.message), /mcp_server/);
		assert.ok(service.launchFailures.length >= 1);
	} finally {
		service.dispose();
	}
});
