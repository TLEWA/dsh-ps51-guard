/**
 * dsh-ps51-guard: a transport and compatibility guard for Windows PowerShell
 * 5.1 invoked through bash (ops_bash).
 *
 * The plugin adds no model visible tool. It repoints BASH_ENV at a shim that
 * optionally sends bare powershell to pwsh 7, rewrites 5.1 incompatibilities,
 * forwards commands to a resident 5.1 host to skip the cold start, and falls
 * back to a plain spawn whenever anything unexpected happens.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShim } from './shim.js';
import { defaultExecutablePath, resolveVersionCached } from './resolver.js';
import { isPwsh7Enabled, resolvePwsh } from './pwsh7.js';
import { killHost, probePipe, spawnHost } from './host-control.js';

export const name = 'dsh-ps51-guard';
export const inject = [];

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @param {object} ctx Cordis context
 */
export function apply(ctx) {
	const warn = (message) => {
		try {
			ctx.logger('dsh-ps51-guard').warn(message);
		} catch {
			// logging is best effort
		}
	};
	if (process.platform !== 'win32') return;
	if (process.env.PS51_GUARD === '0') {
		warn('PS51_GUARD=0: PowerShell 5.1 guard and the pwsh 7 redirect are disabled');
		return;
	}

	const executable = defaultExecutablePath();
	const hasPs51 = existsSync(executable);
	const pwsh7Enabled = isPwsh7Enabled(process.env.PS51_PWSH7);
	const pwsh7 = pwsh7Enabled ? resolvePwsh() : null;
	if (pwsh7Enabled && !pwsh7) {
		warn('PowerShell 7 (pwsh.exe) not found; bare powershell keeps its normal target');
	}
	if (!hasPs51 && !pwsh7) {
		warn('neither ' + executable + ' nor pwsh.exe was found; plugin disabled');
		return;
	}

	const user = (() => {
		try {
			return userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
		} catch {
			return 'user';
		}
	})();
	// The version cache is shared per user, but the shim and host pid file are
	// per DSH process: two sessions must not overwrite each other's host.
	const runtimeRoot = join(tmpdir(), 'dsh-ps51-guard-' + user);
	const runtime = join(runtimeRoot, 'session-' + process.pid);
	const client = join(PACKAGE_ROOT, 'lib', 'client.js');
	const hostScript = join(PACKAGE_ROOT, 'host', 'ps51-host.ps1');
	const shimPath = join(runtime, 'bash-env.sh');
	// One host per DSH process: Windows tears a child down with its parent, so
	// the host has to belong to this long lived process rather than to a
	// short lived bash command.
	const pipe = 'dsh-ps51-guard-' + process.pid;

	try {
		mkdirSync(runtime, { recursive: true });
	} catch {
		// covered by the version probe below
	}

	const resolved = hasPs51 ? resolveVersionCached(join(runtimeRoot, 'version.json'), executable) : { major: null };
	const guard = hasPs51 && resolved.major === 5;
	// When the redirect is active it owns every command word that would hit the
	// 5.1 guard, so warming the host would only create an unused process.
	const warmHost = guard && !pwsh7;
	if (hasPs51 && !guard) {
		warn('powershell.exe reports major version ' + resolved.major + '; the 5.1 guard stays inactive');
	}
	if (!guard && !pwsh7) {
		warn('no usable PowerShell target was found; plugin disabled');
		return;
	}

	const marker = new Date().toISOString();
	try {
		writeFileSync(
			shimPath,
			buildShim({
				executable,
				node: process.execPath,
				client,
				hostScript,
				runtime,
				pipe,
				marker,
				pwsh7,
				guard,
			}),
			'utf8'
		);
	} catch (error) {
		warn('could not write the BASH_ENV shim (' + error.message + '); plugin disabled');
		return;
	}

	const previousBashEnv = process.env.BASH_ENV;
	const previousGuardEnv = process.env.PS51_PREV_BASH_ENV;
	if (previousBashEnv) process.env.PS51_PREV_BASH_ENV = previousBashEnv;
	process.env.BASH_ENV = shimPath;

	// The first command may arrive before the host finishes starting; the
	// client probes for a couple of seconds, so a cold start is not a failure.
	let hostChild = null;
	let disposed = false;
	if (warmHost) {
		void (async () => {
			try {
				if (await probePipe(pipe, 200)) return;
				const child = spawnHost({ executable, hostScript, runtime, pipe });
				// The plugin may be disposed while the host is starting; do not
				// leave that process behind after the shim has been removed.
				if (disposed) {
					try {
						child.kill();
					} catch {
						// already gone
					}
					return;
				}
				hostChild = child;
				debugLog(ctx, 'resident host started, pid ' + hostChild.pid);
			} catch (error) {
				debugLog(ctx, 'resident host did not start: ' + error.message);
			}
		})();
	}

	const dispose = () => {
		disposed = true;
		if (previousBashEnv === undefined) delete process.env.BASH_ENV;
		else process.env.BASH_ENV = previousBashEnv;
		if (previousGuardEnv === undefined) delete process.env.PS51_PREV_BASH_ENV;
		else process.env.PS51_PREV_BASH_ENV = previousGuardEnv;
		if (warmHost) {
			if (hostChild !== null) {
				try {
					hostChild.kill();
				} catch {
					// already gone
				}
			} else {
				killHost(runtime);
			}
		}
	};
	if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
	else if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
}

/**
 * @param {object} ctx
 * @param {string} message
 */
function debugLog(ctx, message) {
	try {
		ctx.logger('dsh-ps51-guard').debug(message);
	} catch {
		// logging is best effort
	}
}
