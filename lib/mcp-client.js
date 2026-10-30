/**
 * mcp-client.js — minimal Model Context Protocol client over stdio.
 *
 * ARTEMIS ships a Python MCP server (`python -m mcp_server`) that speaks
 * newline-delimited JSON-RPC on stdin/stdout. DSH has no built-in MCP client in
 * every profile, so the plugin carries its own: spawn, handshake, request,
 * notification handling, timeout, abort, and crash recovery.
 *
 * Deliberately dependency-free: the only contract is the wire format.
 *
 * @module dsh-plugin-artemis/lib/mcp-client
 */

import { spawn } from "node:child_process";

/** Protocol revision this client speaks; a server may answer with its own. */
export const PROTOCOL_VERSION = "2024-11-05";

/** Error raised for protocol, transport, and lifecycle failures. */
export class McpError extends Error {
	/**
	 * @param {string} message - human-readable failure.
	 * @param {{code?: string, cause?: unknown}} [options] - optional machine code and cause.
	 */
	constructor(message, options = {}) {
		super(message);
		this.name = "McpError";
		if (options.code !== undefined) this.code = options.code;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

/**
 * Split a growing buffer into complete lines.
 * @param {string} buffer - accumulated stdout text.
 * @returns {{lines: string[], rest: string}} complete lines and the unfinished tail.
 */
export function splitLines(buffer) {
	const lines = [];
	let rest = buffer;
	while (true) {
		const index = rest.indexOf("\n");
		if (index === -1) break;
		lines.push(rest.slice(0, index).replace(/\r$/, ""));
		rest = rest.slice(index + 1);
	}
	return { lines, rest };
}

/**
 * Read the text payload out of an MCP `tools/call` result.
 *
 * ARTEMIS returns either plain text (hierarchy, error strings, `file://` URIs)
 * or a JSON object serialized into one text block. Both are handled.
 *
 * @param {{content?: Array<{type: string, text?: string}>, isError?: boolean}} result - raw MCP result.
 * @returns {{text: string, json: unknown, images: Array<{data: string, mimeType?: string}>, isError: boolean}} normalized payload.
 */
export function normalizeToolResult(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const text = blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	const images = blocks
		.filter((block) => block?.type === "image" && typeof block.data === "string")
		.map((block) => ({ data: block.data, mimeType: block.mimeType }));
	let json = null;
	if (text.trim() !== "") {
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object") json = parsed;
		} catch {
			json = null;
		}
	}
	return { text, json, images, isError: result?.isError === true };
}

/**
 * A single stdio MCP server connection, restarted on demand after a crash.
 */
export class McpStdioClient {
	/** @type {import("node:child_process").ChildProcess | null} */
	#child = null;
	#buffer = "";
	/** @type {string[]} */
	#stderr = [];
	#nextId = 1;
	/** @type {Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
	#pending = new Map();
	/** @type {Promise<unknown> | null} */
	#starting = null;
	#closed = false;
	/** @type {Array<{name: string, description?: string, inputSchema?: unknown}> | null} */
	#tools = null;

	/**
	 * @param {object} options - launch and lifecycle options.
	 * @param {string} options.command - executable to spawn.
	 * @param {string[]} options.args - arguments for the executable.
	 * @param {string} [options.cwd] - working directory (the ARTEMIS checkout).
	 * @param {Record<string, string>} [options.env] - extra environment variables.
	 * @param {number} [options.startupTimeoutMs] - handshake budget.
	 * @param {{info?: Function, warn?: Function, debug?: Function}} [options.logger] - optional logger.
	 */
	constructor(options) {
		this.command = options.command;
		this.args = options.args ?? [];
		this.cwd = options.cwd;
		this.env = options.env ?? {};
		this.startupTimeoutMs = options.startupTimeoutMs ?? 120000;
		this.logger = options.logger;
	}

	/** Whether a server process is currently attached. */
	get running() {
		return this.#child !== null;
	}

	/** The tail of the server's stderr, for error messages and `artemis_doctor`. */
	get stderrTail() {
		return this.#stderr.slice(-40).join("\n");
	}

	/** The tool catalogue reported by the server, once discovered. */
	get tools() {
		return this.#tools;
	}

	/** Spawn and handshake, reusing an in-flight or live connection. */
	async start() {
		if (this.#closed) throw new McpError("the ARTEMIS MCP client was already closed");
		if (this.#child !== null) return undefined;
		if (this.#starting !== null) return this.#starting;
		this.#starting = this.#spawnAndHandshake().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}

	/** @returns {Promise<unknown>} the initialize result. */
	async #spawnAndHandshake() {
		this.logger?.info?.(`starting ARTEMIS MCP server: ${this.command} ${this.args.join(" ")}`);
		let child;
		try {
			child = spawn(this.command, this.args, {
				cwd: this.cwd === "" ? undefined : this.cwd,
				env: { ...process.env, ...this.env },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			throw new McpError(`could not spawn the ARTEMIS MCP server (${this.command}): ${error.message}`, {
				code: "SPAWN_FAILED",
				cause: error,
			});
		}
		this.#child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			for (const line of String(chunk).split(/\r?\n/)) {
				if (line.trim() === "") continue;
				this.#stderr.push(line);
				if (this.#stderr.length > 200) this.#stderr.shift();
			}
		});
		child.on("error", (error) => {
			this.#stderr.push(`spawn error: ${error.message}`);
			this.#failPending(new McpError(`ARTEMIS MCP server failed to start: ${error.message}`, { code: "SPAWN_FAILED" }));
		});
		child.on("exit", (code, signal) => {
			this.#child = null;
			this.#tools = null;
			const detail = signal === null ? `code ${code}` : `signal ${signal}`;
			this.#failPending(
				new McpError(`ARTEMIS MCP server exited (${detail}).`, { code: "SERVER_EXITED" }),
			);
		});

		const initialized = await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "dsh-plugin-artemis", version: "0.1.0" },
			},
			{ timeoutMs: this.startupTimeoutMs },
		);
		this.#send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
		return initialized;
	}

	/**
	 * Handle one stdout chunk: complete JSON-RPC frames only.
	 * @param {string} chunk - decoded stdout text.
	 */
	#onStdout(chunk) {
		const split = splitLines(this.#buffer + chunk);
		this.#buffer = split.rest;
		for (const line of split.lines) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let message;
			try {
				message = JSON.parse(trimmed);
			} catch {
				// Non-JSON chatter on stdout must never break the transport.
				this.logger?.debug?.(`ARTEMIS MCP server wrote a non-JSON line: ${trimmed.slice(0, 200)}`);
				continue;
			}
			if (message !== null && typeof message === "object" && typeof message.id === "number") {
				const entry = this.#pending.get(message.id);
				if (entry === undefined) continue;
				this.#pending.delete(message.id);
				clearTimeout(entry.timer);
				if (message.error !== undefined) {
					const text = message.error?.message ?? JSON.stringify(message.error);
					entry.reject(new McpError(`ARTEMIS MCP error: ${text}`, { code: message.error?.code ?? "RPC_ERROR" }));
				} else {
					entry.resolve(message.result);
				}
				continue;
			}
			// Server-initiated notifications (progress, logging) are informational only.
			if (typeof message?.method === "string") {
				this.logger?.debug?.(`ARTEMIS MCP notification: ${message.method}`);
			}
		}
	}

	/**
	 * Write one JSON-RPC frame.
	 * @param {object} frame - the frame to serialize.
	 */
	#send(frame) {
		const child = this.#child;
		if (child === null || child.stdin === null) {
			throw new McpError("ARTEMIS MCP server is not running", { code: "NOT_RUNNING" });
		}
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	/**
	 * Issue a request and await its response.
	 * @param {string} method - JSON-RPC method.
	 * @param {object} params - method parameters.
	 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - timeout and cancellation.
	 * @returns {Promise<unknown>} the result member of the response.
	 */
	async request(method, params, options = {}) {
		const id = this.#nextId++;
		const timeoutMs = options.timeoutMs ?? 120000;
		const signal = options.signal;
		return new Promise((resolve, reject) => {
			if (signal?.aborted === true) {
				reject(new McpError("cancelled before the request was sent", { code: "ABORTED" }));
				return;
			}
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
				reject(
					new McpError(`ARTEMIS MCP request "${method}" timed out after ${budget}`, {
						code: "TIMEOUT",
					}),
				);
			}, timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
			this.#pending.set(id, { resolve, reject, timer });
			const onAbort = () => {
				if (!this.#pending.has(id)) return;
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(new McpError("request cancelled by the caller", { code: "ABORTED" }));
			};
			signal?.addEventListener?.("abort", onAbort, { once: true });
			try {
				this.#send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	/**
	 * Call one server tool.
	 * @param {string} name - tool name (for example `mobile_run_task`).
	 * @param {object} args - tool arguments.
	 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] - timeout and cancellation.
	 * @returns {Promise<{text: string, json: unknown, images: Array<{data: string, mimeType?: string}>, isError: boolean}>} normalized payload.
	 */
	async callTool(name, args, options = {}) {
		await this.start();
		const result = await this.request("tools/call", { name, arguments: args ?? {} }, options);
		return normalizeToolResult(result);
	}

	/** Discover and cache the server tool catalogue. */
	async listTools() {
		await this.start();
		if (this.#tools !== null) return this.#tools;
		const result = await this.request("tools/list", {}, { timeoutMs: this.startupTimeoutMs });
		const tools = Array.isArray(result?.tools) ? result.tools : [];
		this.#tools = tools;
		return tools;
	}

	/**
	 * Reject every in-flight request.
	 * @param {Error} error - the failure to propagate.
	 */
	#failPending(error) {
		for (const [id, entry] of this.#pending) {
			this.#pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	/** Terminate the server process and refuse further starts. */
	close() {
		this.#closed = true;
		const child = this.#child;
		this.#child = null;
		this.#tools = null;
		this.#failPending(new McpError("ARTEMIS MCP client closed", { code: "CLOSED" }));
		if (child !== null) {
			try {
				child.kill();
			} catch {
				// The process may already be gone; nothing left to release.
			}
		}
	}
}
