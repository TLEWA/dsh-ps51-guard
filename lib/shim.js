/**
 * BASH_ENV shim renderer.
 *
 * DSH starts every bash command with BASH_ENV pointing at a shell file, so the
 * shim is the only place where a guard can see a command before bash expands
 * it. The bash source lives in shim.template.sh; this module substitutes the
 * machine specific paths and flags.
 *
 * The generated file:
 *
 * 1. chain-loads the BASH_ENV that was active before this plugin (a shell can
 *    only have one, so every plugin has to cooperate);
 * 2. optionally redirects powershell / powershell.exe to pwsh 7 (the feature
 *    dsh-pwsh7-bash used to provide, now controlled by PS51_PWSH7);
 * 3. installs a DEBUG trap and 5.1 functions only when the command would
 *    otherwise execute the real 5.1 executable. A function already defined by
 *    another plugin, or a PATH wrapper, keeps ownership of the command word.
 */

import { readFileSync } from 'node:fs';

const TEMPLATE = readFileSync(new URL('./shim.template.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/**
 * @param {{executable: string, node: string, client: string, hostScript: string, runtime: string, pipe: string, marker: string, pwsh7?: string | null, guard?: boolean}} config
 * @returns {string} bash source for bash-env.sh
 */
export function buildShim(config) {
	const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
	const expected = String(config.executable).replace(/\\/g, '/').toLowerCase();
	const marker = String(config.marker).replace(/[\r\n]+/g, ' ');
	const values = {
		MARKER: marker,
		NODE: quote(config.node),
		CLIENT: quote(config.client),
		HOST: quote(config.hostScript),
		EXE: quote(config.executable),
		RUNTIME: quote(config.runtime),
		PIPE: quote(config.pipe),
		EXPECTED: quote(expected),
		GUARD: config.guard === false ? '0' : '1',
		PWSH7: config.pwsh7 ? quote(config.pwsh7) : "''",
	};
	let output = TEMPLATE;
	for (const [key, value] of Object.entries(values)) {
		output = output.split('@@' + key + '@@').join(value);
	}
	return output.split('@@DL@@').join('$' + '{');
}
