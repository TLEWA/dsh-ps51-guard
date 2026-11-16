/**
 * Locate PowerShell 7 for the optional bare-powershell redirect.
 *
 * This is the behaviour that used to live in dsh-pwsh7-bash: when enabled,
 * "powershell" and "powershell.exe" call pwsh instead of Windows PowerShell
 * 5.1. The redirect is installed by the generated BASH_ENV shim, not by this
 * module; here we only decide which executable to use.
 */

import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

function isFile(path) {
	try {
		const stat = lstatSync(path);
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function fromEnv(variable) {
	const value = process.env[variable];
	if (typeof value !== 'string') return [];
	const trimmed = value.trim().replace(/^"|"$/gu, '');
	return trimmed ? [trimmed] : [];
}

/**
 * Candidate pwsh.exe paths, most explicit first. PS51_PWSH7_PATH is this
 * plugin's own override; the other two names are kept so an existing
 * dsh-pwsh7-bash configuration keeps working during the migration.
 * @returns {string[]}
 */
function candidatePaths() {
	const candidates = [];
	candidates.push(...fromEnv('PS51_PWSH7_PATH'));
	candidates.push(...fromEnv('PWSH7_BASH_PWSH'));
	candidates.push(...fromEnv('DSH_PWSH_PATH'));
	const roots = [
		process.env.ProgramFiles,
		process.env.ProgramW6432,
		process.env.SystemDrive ? join(process.env.SystemDrive, 'Program Files') : undefined,
	];
	for (const root of roots) {
		if (root) candidates.push(join(root, 'PowerShell', '7', 'pwsh.exe'));
	}
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) candidates.push(join(localAppData, 'Programs', 'PowerShell', '7', 'pwsh.exe'));
	const home = homedir();
	if (home) candidates.push(join(home, 'scoop', 'apps', 'pwsh', 'current', 'pwsh.exe'));
	const pathValue = process.env.Path || process.env.PATH || '';
	for (const entry of pathValue.split(delimiter)) {
		const dir = entry.trim().replace(/^"|"$/gu, '');
		if (dir) candidates.push(join(dir, 'pwsh.exe'));
	}
	return candidates;
}

/**
 * @returns {string | null} absolute path of pwsh.exe, or null when absent
 */
export function resolvePwsh() {
	for (const candidate of candidatePaths()) {
		if (candidate && isFile(candidate)) return candidate;
	}
	return null;
}

/**
 * PS51_PWSH7 defaults to on. Only an explicit off value disables it, so a
 * typo cannot silently change which PowerShell a session uses.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isPwsh7Enabled(value) {
	if (value === undefined) return true;
	return !/^(0|false|no|off)$/iu.test(String(value).trim());
}
