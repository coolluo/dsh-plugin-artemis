/**
 * mock-mcp-server.js — a stdio MCP server that imitates ARTEMIS's five tools.
 *
 * Used by tests/integration.test.js to exercise the real transport (child
 * process, newline JSON-RPC, polling) without ARTEMIS, a device, or an API key.
 *
 * Behaviour mirrors ARTEMIS where it matters for the client:
 *   - mobile_run_task returns immediately with a trace_id
 *   - the first status poll reports "running", the next reports "completed"
 *   - mobile_get_device_state writes a screenshot file and returns its file:// URI
 *
 * Run it directly to see it answer a handshake on stdin/stdout.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const state = { statusPolls: 0 };
const screenshotPath = join(process.env.MOCK_SCREENSHOT_DIR ?? process.cwd(), "mock_screenshot.jpg");

/** Write one JSON-RPC frame. */
function send(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** Wrap a JSON payload the way FastMCP serializes a dict tool result. */
function textResult(payload) {
	return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

const tools = [
	"mobile_run_task",
	"mobile_manage_task",
	"mobile_get_device_state",
	"mobile_inspect_trace",
	"mobile_diagnose",
].map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object", properties: {} } }));

/**
 * Answer one request frame.
 * @param {{id: number, method: string, params?: object}} message - incoming frame.
 */
function handle(message) {
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "mock-artemis", version: "0.0.0" },
			},
		});
		return;
	}
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
	if (message.method === "tools/call") {
		const name = message.params?.name;
		const args = message.params?.arguments ?? {};
		if (name === "mobile_run_task") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: textResult({
					trace_id: "mock-trace-1",
					device_serial: args.device_serial ?? "emulator-5554",
					stdout_log: "C:\\mock\\stdout.log",
					stderr_log: "C:\\mock\\stderr.log",
					message: "Successfully started background task.",
				}),
			});
			return;
		}
		if (name === "mobile_manage_task") {
			if (args.action !== "status") {
				send({ jsonrpc: "2.0", id: message.id, result: textResult({ trace_id: args.trace_id, status: "cancelled" }) });
				return;
			}
			state.statusPolls += 1;
			const running = state.statusPolls === 1;
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: textResult({
					trace_id: args.trace_id,
					status: running ? "running" : "completed",
					device_serial: "emulator-5554",
					elapsed_seconds: running ? 3 : 42.5,
					model: "Flash",
					result: running ? undefined : "Battery 100 percent",
					progress: running ? { phase: "running_flash_loop", current_turn: 2 } : undefined,
				}),
			});
			return;
		}
		if (name === "mobile_get_device_state") {
			if (args.view_type === "screenshot") {
				writeFileSync(screenshotPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
				send({ jsonrpc: "2.0", id: message.id, result: textResult(`file://${screenshotPath}`) });
				return;
			}
			send({ jsonrpc: "2.0", id: message.id, result: textResult("[1] Text: 'Battery' | Bounds: [0,0][100,40]") });
			return;
		}
		if (name === "mobile_diagnose") {
			const respond = () =>
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: textResult({
						verdict: "ready",
						summary: "5/5 required checks pass (ready).",
						next_steps: ["Environment is ready. Use mobile_run_task to delegate a task."],
						checks: [],
					}),
				});
			// MOCK_SLOW=1 makes the call outlive a short client timeout.
			if (process.env.MOCK_SLOW === "1") setTimeout(respond, 3000);
			else respond();
			return;
		}
		if (name === "mobile_inspect_trace") {
			// action="crash" kills the server, to prove the client recovers on the next call.
			if (args.action === "crash") {
				setTimeout(() => process.exit(1), 10);
				return;
			}
			const respond = () =>
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: textResult({ trace_id: args.trace_id, action: args.action, steps: [] }),
				});
			if (process.env.MOCK_SLOW === "1") setTimeout(respond, 3000);
			else respond();
			return;
		}
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true },
		});
		return;
	}
	send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (line.trim() === "") return;
	try {
		handle(JSON.parse(line));
	} catch (error) {
		process.stderr.write(`mock server parse error: ${error.message}\n`);
	}
});
