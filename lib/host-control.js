/**
 * Resident host lifecycle helpers shared by the plugin entry, the client and
 * the tests.
 *
 * The host is a plain long lived PowerShell 5.1 process. Its lifetime follows
 * the process that starts it: when that process exits, Windows tears the host
 * down too (verified on this machine), so the plugin starts the host from its
 * own long lived apply() and the client only starts one as a last resort for a
 * single call.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Turn a pipe name into the path node's net.connect expects.
 * @param {string} name
 * @returns {string}
 */
export function pipePath(name) {
	if (name.startsWith('\\\\')) return name;
	return '\\\\.\\pipe\\' + name;
}

/**
 * Try to connect once. A successful connect means a host is listening.
 * @param {string} name pipe name
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function probePipe(name, timeoutMs) {
	return new Promise((resolve) => {
		const socket = connect(pipePath(name));
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		socket.on('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.on('error', () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

/**
 * Start the resident host and remember its pid for cleanup.
 * @param {{executable: string, hostScript: string, runtime: string, pipe: string}} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnHost({ executable, hostScript, runtime, pipe }) {
	// windowsHide keeps a console from flashing; stdio ignore keeps the host
	// from holding the caller's pipes open.
	const child = spawn(
		executable,
		['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript, '-PipeName', pipe],
		{ stdio: 'ignore', windowsHide: true, env: { ...process.env, PS51_RUNTIME: runtime } }
	);
	child.unref();
	try {
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, 'host.pid'), String(child.pid), 'utf8');
	} catch {
		// the pid file only serves timeout cleanup
	}
	return child;
}

/**
 * Kill the leftover host recorded in runtime/host.pid.
 * @param {string} runtime
 */
export function killHost(runtime) {
	const pidFile = join(runtime, 'host.pid');
	try {
		const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
		if (Number.isFinite(pid) && pid > 0) process.kill(pid);
	} catch {
		// already gone
	}
	try {
		unlinkSync(pidFile);
	} catch {
		// already gone
	}
}
