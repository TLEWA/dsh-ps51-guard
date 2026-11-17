/**
 * pwsh 7 redirect tests: the feature that used to live in dsh-pwsh7-bash is
 * now part of this plugin and must stay switchable.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime, runBash } from './helpers/shim.mjs';
import { isPwsh7Enabled, resolvePwsh } from '../lib/pwsh7.js';

let passed = 0;
const failures = [];

function test(name, body) {
	try {
		body();
		passed += 1;
		console.log('ok - ' + name);
	} catch (error) {
		failures.push(name);
		console.log('not ok - ' + name);
		console.log('    ' + (error && error.message ? error.message : String(error)));
	}
}

if (process.platform !== 'win32') {
	console.log('pwsh7: skipped (requires Windows and bash)');
	process.exit(0);
}

test('PS51_PWSH7 defaults to on and only explicit off values disable it', () => {
	assert.equal(isPwsh7Enabled(undefined), true);
	assert.equal(isPwsh7Enabled('1'), true);
	assert.equal(isPwsh7Enabled(''), true);
	assert.equal(isPwsh7Enabled('0'), false);
	assert.equal(isPwsh7Enabled('off'), false);
});

const pwsh = resolvePwsh();
if (!pwsh) {
	console.log('pwsh7: skipped (pwsh.exe not found)');
	process.exit(0);
}

const runtime = createRuntime({ pwsh7: pwsh, guard: false });
const wrapperDir = mkdtempSync(join(tmpdir(), 'ps51-pwsh7-wrapper-'));
const wrapper = join(wrapperDir, 'powershell');
writeFileSync(wrapper, '#!/usr/bin/env bash\necho wrapper-ok\n', 'utf8');
chmodSync(wrapper, 0o755);
const previousShim = join(runtime.runtime, 'previous-bash-env.sh');
writeFileSync(previousShim, 'powershell() { echo function-ok; }\n', 'utf8');
const loopShim = join(runtime.runtime, 'loop-previous.sh');
writeFileSync(loopShim, '. "$BASH_ENV"\n', 'utf8');
const weirdDir = mkdtempSync(join(tmpdir(), 'ps51-pwsh7-$not_defined-`x`-'));
const weirdPwsh = join(weirdDir, 'pwsh.exe').replace(/\\/g, '/');
const weirdRuntime = createRuntime({ pwsh7: weirdPwsh, guard: false });

try {
	test('bare powershell goes to PowerShell 7 by default', () => {
		const result = runBash('powershell -NoProfile -Command \'$PSVersionTable.PSVersion.Major\'', {
			runtime,
			env: { PS51_PWSH7: '' },
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^7\s*$/m);
		assert.doesNotMatch(result.stderr, /\[ps51\]/);
	});

	test('powershell.exe goes to PowerShell 7 too', () => {
		const result = runBash('powershell.exe -NoProfile -Command \'$PSVersionTable.PSVersion.Major\'', {
			runtime,
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^7\s*$/m);
	});

	test('PS51_PWSH7=0 keeps Windows PowerShell 5.1', () => {
		const result = runBash('powershell -NoProfile -Command \'$PSVersionTable.PSVersion.Major\'', {
			runtime,
			env: { PS51_PWSH7: '0' },
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^5\b/m);
	});

	test('a PATH wrapper keeps ownership under the redirect', () => {
		const result = runBash('powershell -NoProfile -Command "Write-Output redirected"', {
			runtime,
			env: { PATH: wrapperDir + ':' + (process.env.PATH ?? '') },
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /wrapper-ok/);
		assert.doesNotMatch(result.stdout, /^7\s*$/m);
	});

	test('a function from the previous BASH_ENV keeps ownership', () => {
		const result = runBash('powershell -NoProfile -Command "Write-Output redirected"', {
			runtime,
			env: { PS51_PREV_BASH_ENV: previousShim.replace(/\\/g, '/') },
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /function-ok/);
	});

	test('a previous BASH_ENV that sources the shim does not recurse', () => {
		const result = runBash('type -t powershell', {
			runtime,
			env: { PS51_PREV_BASH_ENV: loopShim.replace(/\\/g, '/') },
			timeoutMs: 15000,
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /function/);
	});
	test('a pwsh path with shell metacharacters stays literal in the function', () => {
		const result = runBash('type powershell', { runtime: weirdRuntime });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /\$__ps51_pwsh7/);
		assert.doesNotMatch(result.stderr, /x: command not found/);
	});
} finally {
	runtime.cleanup();
	weirdRuntime.cleanup();
	rmSync(wrapperDir, { recursive: true, force: true });
	rmSync(weirdDir, { recursive: true, force: true });
}

console.log('pwsh7: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length > 0) process.exitCode = 1;
