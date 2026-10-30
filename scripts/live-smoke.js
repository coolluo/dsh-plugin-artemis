/**
 * Live smoke test for the plugin's service layer, run outside DSH.
 *
 * It exercises the parts DSH integration cannot prove by itself: launcher
 * discovery, the MCP handshake, tool listing, diagnosis, and a real device
 * observation against the attached emulator.
 *
 * Usage: node scripts/live-smoke.js <artemis-path>
 */

import { ArtemisService } from "../lib/artemis.js";
import { resolveConfig } from "../lib/config.js";

const artemisPath = process.argv[2] ?? "";
const { config, warnings } = resolveConfig({ artemisPath, defaultWaitSeconds: 60 });
if (warnings.length > 0) console.log("config warnings:", warnings);

const service = new ArtemisService({ config, logger: { info: (m) => console.log("[info]", m), warn: (m) => console.log("[warn]", m), debug: () => {} } });

function line(title) {
	console.log(`\n=== ${title} ===`);
}

try {
	line("handshake + tools/list");
	const client = await service.ensureClient();
	console.log("launcher:", service.activeLauncher?.label ?? "(unknown)");
	const tools = await client.listTools();
	for (const tool of tools) console.log(`  - ${tool.name}`);

	line("mobile_diagnose (verdict, first steps)");
	const diagnosis = await service.diagnose({});
	console.log("verdict:", diagnosis?.verdict);
	console.log("summary:", diagnosis?.summary);
	for (const step of (diagnosis?.next_steps ?? []).slice(0, 6)) console.log("  " + step);

	line("mobile_get_device_state(hierarchy)");
	const state = await service.deviceState({ viewType: "hierarchy" });
	console.log(`chars: ${state.hierarchy?.length ?? 0}`);
	console.log((state.hierarchy ?? "").split("\n").slice(0, 12).join("\n"));

	line("mobile_get_device_state(screenshot)");
	const shot = await service.deviceState({ viewType: "screenshot" });
	console.log("uri:", shot.uri);
} catch (error) {
	console.error("\nSMOKE FAILED:", error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	service.dispose();
}
