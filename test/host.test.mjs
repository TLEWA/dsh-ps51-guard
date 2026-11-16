/**
 * Resident host integration test.
 *
 * Talks the framing protocol directly so a run measures the host itself:
 * 200 sequential executions on one connection, plus restart recovery after an
 * unexpected host exit. Latency numbers are printed for docs/measurements.md.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeFrame, FrameDecoder } from '../lib/frames.js';
import { EXECUTABLE, PIPE, createRuntime } from './helpers/shim.mjs';

// The host is a PowerShell 5.1 process; nothing to run on other platforms.
if (process.platform !== 'win32') {
	console.log('host: skipped (requires Windows PowerShell 5.1)');
	process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const HOST_SCRIPT = join(ROOT, 'host', 'ps51-host.ps1');
const EXECUTIONS = 200;

let host = null;
let socket = null;
let decoder = new FrameDecoder();
let pendingOut = [];
let pendingErr = [];
let failures = [];
let passed = 0;

/**
 * @param {string} name
 * @param {() => Promise<void>} body
 */
async function test(name, body) {
	try {
		await body();
		passed += 1;
		console.log('ok - ' + name);
	} catch (error) {
		failures.push(name);
		console.log('not ok - ' + name);
		console.log('    ' + (error && error.message ? error.message : String(error)));
	}
}

/** Spawn one host and wait for it (a plain process, unlike the plugin path). */
function startHost() {
	host = spawn(
		EXECUTABLE,
		['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT, '-PipeName', PIPE],
		{ stdio: 'ignore', windowsHide: true, env: { ...process.env, PS51_RUNTIME: runtime.runtime, PS51_TRACE: '1' } }
	);
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<import('node:net').Socket>}
 */
function connectHost(timeoutMs) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = () => {
			const next = connect('\\\\.\\pipe\\' + PIPE);
			next.once('connect', () => resolve(next));
			next.once('error', (error) => {
				next.destroy();
				if (Date.now() > deadline) reject(error);
				else setTimeout(attempt, 50);
			});
		};
		attempt();
	});
}

/**
 * Send one request and resolve on its exit frame.
 * @param {object} request
 * @param {number} timeoutMs
 */
function send(request, timeoutMs) {
	return new Promise((resolve, reject) => {
		pendingOut = [];
		pendingErr = [];
		const timer = setTimeout(() => {
			socket.off('data', onData);
			reject(new Error('timed out waiting for ' + request.op));
		}, timeoutMs);
		const onData = (chunk) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				clearTimeout(timer);
				socket.off('data', onData);
				reject(error);
				return;
			}
			for (const frame of frames) {
				if (frame.type === 'pong') {
					clearTimeout(timer);
					socket.off('data', onData);
					resolve({ code: 0, out: '', err: '', parseError: null, pong: true });
					return;
				}
				if (frame.type === 'out') pendingOut.push(Buffer.from(frame.dataB64, 'base64').toString('utf8'));
				else if (frame.type === 'err') pendingErr.push(Buffer.from(frame.dataB64, 'base64').toString('utf8'));
				else if (frame.type === 'exit') {
					clearTimeout(timer);
					socket.off('data', onData);
					resolve({ code: frame.code, out: pendingOut.join(''), err: pendingErr.join(''), parseError: frame.parseError ?? null });
					return;
				}
			}
		};
		socket.on('data', onData);
		socket.write(encodeFrame(request));
	});
}

const runtime = createRuntime();
const latencies = [];
// Present in the host baseline so the complete-snapshot test can prove that a
// variable the caller removed is actually removed inside the host.
process.env.DSH_PS51_ENV_PROBE = 'baseline';

try {
	startHost();
	await test('host starts and answers ping', async () => {
		socket = await connectHost(15000);
		const pong = await send({ id: 'ping-1', op: 'ping' }, 5000);
		assert.ok(pong);
	});

	await test('runs ' + EXECUTIONS + ' sequential executions on one host', async () => {
		for (let i = 0; i < EXECUTIONS; i += 1) {
			const started = process.hrtime.bigint();
			const outcome = await send({ id: 'run-' + i, op: 'exec', script: 'Write-Output run-' + i }, 20000);
			latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
			if (outcome.code !== 0) throw new Error('run ' + i + ' exited ' + outcome.code + ': ' + outcome.err);
			if (!outcome.out.includes('run-' + i)) throw new Error('run ' + i + ' lost its output: ' + JSON.stringify(outcome.out));
		}
	});

	await test('reports errors and exit codes like -Command', async () => {
		const failed = await send({ id: 'err-1', op: 'exec', script: "Write-Error boom" }, 10000);
		assert.equal(failed.code, 1);
		assert.match(failed.err, /boom/);
	});

	await test('keeps console output byte for byte', async () => {
		const wrote = await send({ id: 'console-1', op: 'exec', script: '[Console]::Out.Write("a`n`nb")' }, 10000);
		assert.equal(wrote.code, 0);
		assert.equal(wrote.out, 'a\n\nb');
	});

	await test('derives the exit code from the final command status', async () => {
		const failed = await send({ id: 'native-1', op: 'exec', script: 'cmd /c exit 5' }, 10000);
		assert.equal(failed.code, 1);
		const recovered = await send({ id: 'native-2', op: 'exec', script: 'cmd /c exit 3; Write-Output done' }, 10000);
		assert.equal(recovered.code, 0);
		assert.match(recovered.out, /done/);
	});

	await test('feeds request stdin to [Console]::In', async () => {
		const piped = await send(
			{
				id: 'stdin-1',
				op: 'exec',
				script: '[Console]::In.ReadToEnd()',
				stdinB64: Buffer.from('pipe-data').toString('base64'),
			},
			10000
		);
		assert.equal(piped.code, 0);
		assert.match(piped.out, /pipe-data/);
	});

	await test('removes environment variables the request no longer has', async () => {
		const snapshot = { ...process.env };
		delete snapshot.DSH_PS51_ENV_PROBE;
		const cleared = await send(
			{ id: 'env-1', op: 'exec', script: 'Write-Output ("[" + $env:DSH_PS51_ENV_PROBE + "]")', env: snapshot },
			10000
		);
		assert.equal(cleared.code, 0);
		assert.match(cleared.out, /\[\]/);
	});

	await test('survives an unexpected host exit and restarts', async () => {
		host.kill();
		await new Promise((done) => host.once('exit', done));
		socket.destroy();
		startHost();
		socket = await connectHost(15000);
		const pong = await send({ id: 'ping-2', op: 'ping' }, 5000);
		assert.ok(pong);
	});

	await test('stops a running pipeline when the client disconnects', async () => {
		socket.destroy();
		socket = null;
		const cancel = await connectHost(5000);
		cancel.write(
			encodeFrame({
				id: 'cancel-1',
				op: 'exec',
				script: 'Start-Sleep -Seconds 5; Write-Output should-not-run',
			})
		);
		await new Promise((done) => setTimeout(done, 400));
		const exited = new Promise((resolve) => host.once('exit', () => resolve(true)));
		cancel.destroy();
		const stopped = await Promise.race([
			exited,
			new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
		]);
		assert.equal(stopped, true, 'host kept running after the client disconnected');
		const trace = readFileSync(join(runtime.runtime, 'host-trace.log'), 'utf8');
		assert.match(trace, /client disconnected; aborting execution/);
		assert.doesNotMatch(trace, /should-not-run/);

		startHost();
		socket = await connectHost(15000);
		const pong = await send({ id: 'ping-3', op: 'ping' }, 5000);
		assert.ok(pong);
	});
} finally {
	if (socket) socket.destroy();
	if (host) {
		host.kill();
	}
	runtime.cleanup();
}

const sorted = latencies.slice().sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
console.log('host: ' + passed + '/' + (passed + failures.length) + ' passed');
if (latencies.length > 0) {
	console.log(
		'host latency over ' + latencies.length + ' executions: p50=' + percentile(50).toFixed(1) + 'ms p95=' +
			percentile(95).toFixed(1) + 'ms max=' + sorted[sorted.length - 1].toFixed(1) + 'ms'
	);
}
if (failures.length > 0) process.exitCode = 1;
