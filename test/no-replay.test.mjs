/**
 * Regression test for the duplicate-execution finding: once the request has
 * been written to the host, a connection failure must not spawn a second
 * powershell.exe process. The fake host here accepts the frame and disappears,
 * exactly like a host that crashes after receiving work.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const EXECUTABLE = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

if (process.platform !== 'win32') {
	console.log('no-replay: skipped (requires Windows named pipes)');
	process.exit(0);
}

const pipe = 'ps51-no-replay-' + process.pid + '-' + Math.random().toString(16).slice(2, 8);
const runtime = mkdtempSync(join(tmpdir(), 'ps51-no-replay-'));
let server;

/**
 * @param {import('node:net').Socket} socket
 */
function acceptThenVanish(socket) {
	socket.once('data', () => {
		socket.destroy();
	});
}

try {
	server = createServer(acceptThenVanish);
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen('\\\\.\\pipe\\' + pipe, resolve);
	});

	const child = spawn(
		process.execPath,
		[join(ROOT, 'lib', 'client.js'), 'powershell.exe', '-NoProfile', '-Command', 'Write-Output hi'],
		{
			env: {
				...process.env,
				PS51_RAW: 'powershell.exe -NoProfile -Command "Write-Output hi"',
				PS51_EXE: EXECUTABLE,
				PS51_HOST_SCRIPT: join(ROOT, 'host', 'ps51-host.ps1'),
				PS51_RUNTIME: runtime,
				PS51_PIPE: pipe,
				PS51_DIAGNOSTICS: '0',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		}
	);
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
	child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
	const code = await new Promise((resolve) => {
		const timer = setTimeout(() => child.kill(), 15000);
		child.once('exit', (exitCode) => {
			clearTimeout(timer);
			resolve(exitCode);
		});
	});

	assert.equal(code, 125, 'client must fail instead of replaying: ' + stderr);
	assert.match(stderr, /was not retried/);
	assert.doesNotMatch(stdout, /hi/, 'the command must not run through a fallback spawn');
	console.log('ok - a host that dies after receiving work is not retried');
	console.log('no-replay: 1/1 passed');
} finally {
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(runtime, { recursive: true, force: true });
}
