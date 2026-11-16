/**
 * Ownership tests: the guard must only install its functions when bash would
 * otherwise run the real 5.1 executable, never when PATH resolves the command
 * to a wrapper or a different program.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime, runBash } from './helpers/shim.mjs';
import { killHost } from './helpers/host.mjs';

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
	console.log('ownership: skipped (requires Windows and bash)');
	process.exit(0);
}

const runtime = createRuntime();
const wrapperDir = mkdtempSync(join(tmpdir(), 'ps51-wrapper-'));
const wrapper = join(wrapperDir, 'powershell');
writeFileSync(wrapper, '#!/usr/bin/env bash\necho wrapper-ok\n', 'utf8');
chmodSync(wrapper, 0o755);

try {
	test('a PATH wrapper keeps ownership of the command word', () => {
		const result = runBash('powershell -NoProfile -Command "Write-Output guarded"', {
			runtime,
			env: { PATH: wrapperDir + ':' + (process.env.PATH ?? '') },
		});
		assert.equal(result.code, 0);
		assert.match(result.stdout, /wrapper-ok/);
		assert.doesNotMatch(result.stderr, /\[ps51\]/);
	});

	test('the real executable still goes through the guard', () => {
		const result = runBash('powershell -NoProfile -Command "Write-Output guarded"', { runtime });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /guarded/);
	});
} finally {
	killHost(runtime.runtime);
	runtime.cleanup();
	rmSync(wrapperDir, { recursive: true, force: true });
}

console.log('ownership: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length > 0) process.exitCode = 1;
