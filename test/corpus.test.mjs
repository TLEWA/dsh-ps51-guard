/**
 * Corpus test: run real commands through the generated shim and compare
 * observable behaviour (stdout, stderr, exit status).
 *
 * Each case is one command that an agent could issue through ops_bash. The
 * corpus lives in test/corpus/v1.txt so the before/after comparison can be
 * reviewed without reading code.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime, runBash } from './helpers/shim.mjs';
import { startHost, killHost } from './helpers/host.mjs';

// The guard only exists on Windows: elsewhere there is no PowerShell 5.1 to
// drive, so this integration test has nothing to measure.
if (process.platform !== 'win32') {
	console.log('corpus: skipped (requires Windows PowerShell 5.1)');
	process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CORPUS = join(HERE, 'corpus', 'v1.txt');
// -EncodedCommand takes UTF-16LE base64, so derive it instead of pasting bytes.
const ENCODED = Buffer.from('Write-Output enc-ok', 'utf16le').toString('base64');

/**
 * Parse the corpus file into cases.
 * @param {string} text
 * @returns {{name: string, command: string, checks: Record<string, string[]>}[]}
 */
function parseCorpus(text) {
	const cases = [];
	for (const block of text.split(/\n---\n/)) {
		const lines = block.split(/\r?\n/);
		const first = lines.find((line) => line.trim().startsWith('#'));
		if (!first) continue;
		const name = first.replace(/^#\s*/, '').split(':')[0].trim();
		const checks = {};
		for (const line of lines) {
			if (line.trim().startsWith('#') || line.trim() === '') continue;
			const index = line.indexOf(':');
			if (index < 0) continue;
			const key = line.slice(0, index).trim();
			const value = line.slice(index + 1).trim();
			(checks[key] ??= []).push(value);
		}
		if (!checks.command) continue;
		cases.push({ name, command: checks.command.join(' '), checks });
	}
	return cases;
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function expandPlaceholders(name, value, environment) {
	return value
		.replace(/\{\{ENC\}\}/g, ENCODED)
		.replace(/\{\{ROOT\}\}/g, ROOT.replace(/\\/g, '/'))
		.replace(/\{\{TMP\}\}/g, environment.tmp.replace(/\\/g, '/'));
}

const failures = [];
const runtime = createRuntime();
// The plugin starts the host from its own process; the test process plays that
// role so every case talks to an already warm host.
const host = startHost(runtime);
let passed = 0;

try {
	const cases = parseCorpus(readFileSync(CORPUS, 'utf8'));
	console.log('corpus: ' + cases.length + ' cases');

	cases.forEach((testCase, index) => {
		const tmp = join(runtime.runtime, 'case-' + (index + 1));
		mkdirSync(tmp, { recursive: true });
		const command = expandPlaceholders(testCase.name, testCase.command, { tmp });
		const checks = testCase.checks;
		const environment = {};

		const expectedStatus = Number(checks.status?.[0] ?? 0);
		const result = runBash(command, { runtime, env: environment });
		const problems = [];
		if (result.code !== expectedStatus) {
			problems.push('status ' + result.code + ' != ' + expectedStatus);
		}
		for (const want of checks['out-contains'] ?? []) {
			if (!result.stdout.includes(expandPlaceholders(testCase.name, want, { tmp }))) {
				problems.push('stdout missing ' + JSON.stringify(want));
			}
		}
		for (const want of checks['out-matches'] ?? []) {
			if (!new RegExp(expandPlaceholders(testCase.name, want, { tmp })).test(result.stdout)) {
				problems.push('stdout !~ /' + want + '/');
			}
		}
		for (const want of checks['out-equals'] ?? []) {
			if (result.stdout.trim() !== want.trim()) {
				problems.push('stdout != ' + JSON.stringify(want) + ' (got ' + JSON.stringify(result.stdout.trim()) + ')');
			}
		}
		for (const want of checks['out-first-line'] ?? []) {
			if (result.stdout.split(/\r?\n/)[0] !== want) {
				problems.push('first line != ' + JSON.stringify(want));
			}
		}
		for (const want of checks['err-contains'] ?? []) {
			if (!result.stderr.includes(expandPlaceholders(testCase.name, want, { tmp }))) {
				problems.push('stderr missing ' + JSON.stringify(want));
			}
		}
		for (const want of checks['err-not-contains'] ?? []) {
			if (result.stderr.includes(want)) {
				problems.push('stderr should not contain ' + JSON.stringify(want));
			}
		}

		if (problems.length === 0) {
			passed += 1;
			console.log('ok ' + (index + 1) + ' - ' + testCase.name);
			return;
		}
		failures.push({ name: testCase.name, command, problems, result });
		console.log('not ok ' + (index + 1) + ' - ' + testCase.name);
		for (const problem of problems) console.log('    ' + problem);
		console.log('    command: ' + command);
		console.log('    stdout: ' + JSON.stringify(result.stdout.slice(0, 400)));
		console.log('    stderr: ' + JSON.stringify(result.stderr.slice(0, 400)));
	});
} finally {
	host.kill();
	killHost(runtime.runtime);
	runtime.cleanup();
}

console.log('corpus: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length > 0) process.exitCode = 1;
