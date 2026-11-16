/**
 * Locate PowerShell 5.1 and decide which command words may be taken over.
 *
 * The guard must never change the behaviour of pwsh, and never fight another
 * plugin that already redirects "powershell" to pwsh, so takeover is decided
 * per command word from what bash would actually execute.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Command words that can resolve to the 5.1 executable. */
export const COMMAND_WORDS = ['powershell', 'powershell.exe'];

/**
 * @returns {string} absolute path of powershell.exe for this machine
 */
export function defaultExecutablePath() {
	const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
	return join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Ask the executable for its major version.
 * @param {string} executable
 * @returns {{major: number | null, raw: string}}
 */
export function readPowerShellVersion(executable) {
	if (!existsSync(executable)) return { major: null, raw: 'missing' };
	const result = spawnSync(
		executable,
		['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
		{ encoding: 'utf8', timeout: 15000, windowsHide: true }
	);
	const raw = (result.stdout || '').trim();
	const major = Number.parseInt(raw, 10);
	return { major: Number.isFinite(major) ? major : null, raw: raw || String(result.error || 'no output') };
}

/**
 * Version probe with a small on-disk cache so the plugin does not pay a cold
 * start on every session.
 * @param {string} cacheFile
 * @param {string} executable
 * @returns {{major: number | null, cached: boolean}}
 */
export function resolveVersionCached(cacheFile, executable) {
	const stamp = String(Date.now());
	void stamp;
	try {
		const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
		if (cached && cached.executable === executable && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
			return { major: cached.major, cached: true };
		}
	} catch {
		// no cache yet
	}
	const probe = readPowerShellVersion(executable);
	try {
		mkdirSync(dirname(cacheFile), { recursive: true });
		writeFileSync(cacheFile, JSON.stringify({ executable, major: probe.major, at: Date.now() }), 'utf8');
	} catch {
		// cache is an optimisation only
	}
	return { major: probe.major, cached: false };
}
