/**
 * Resident-host helpers shared by the tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnHost } from '../../lib/host-control.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const EXECUTABLE = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/**
 * Start the resident host the way the plugin does, so the shim finds it
 * already listening instead of paying a cold start per call.
 * @param {{runtime: string, pipe: string}} target
 * @param {string} [executable]
 */
export function startHost(target, executable = EXECUTABLE) {
	const child = spawnHost({
		executable,
		hostScript: join(ROOT, 'host', 'ps51-host.ps1'),
		runtime: target.runtime,
		pipe: target.pipe,
	});
	return child;
}

/**
 * Kill the resident host a test run left behind, if any.
 * The host is a normal child process, so the test process must clean it up
 * explicitly; ops_bash only kills the tree it spawned itself.
 * @param {string} runtime
 */
export function killHost(runtime) {
	const file = join(runtime, 'host.pid');
	if (!existsSync(file)) return;
	const pid = Number(readFileSync(file, 'utf8').trim());
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid);
	} catch {
		// already gone
	}
}
