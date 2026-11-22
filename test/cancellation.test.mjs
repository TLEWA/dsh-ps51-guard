/**
 * Cancellation classification.
 *
 * rc.5 reports an aborted run as an AbortError (name `AbortError`, code
 * `ABORT_ERR`). alpha relabels an unclassified error thrown while the caller is
 * aborting as `AbortError` with `ABORTED` or `ABORTED_BEFORE_DISPATCH`
 * (`dsh-tools/src/pipeline.ts:335,339-345`). Both generations must take the
 * cancellation path, and an ordinary failure must keep taking the failure path.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ALPHA_CANCELLATION_CODES,
	CANCELLATION_CODES,
	LEGACY_CANCELLATION_CODES,
	cancellationOf,
	hostFailure,
	isCancellation,
	isCancellationCode,
	isCancellationName,
	reportHostFailure,
	textOf,
} from '../lib/cancellation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const EXECUTABLE = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Collect what the client would write and log. */
function capture(error) {
	const written = [];
	const recorded = [];
	const outcome = reportHostFailure(error, {
		write: (text) => written.push(text),
		record: (entry) => recorded.push(entry),
	});
	return { outcome, written, recorded };
}

test('keeps every cancellation shape rc.5 already produced', () => {
	const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
	assert.equal(isCancellation(abortError), true);
	assert.equal(cancellationOf(abortError).matchedBy, 'name');

	assert.equal(isCancellation({ code: 'ABORT_ERR' }), true);
	assert.equal(cancellationOf({ code: 'ABORT_ERR' }).matchedBy, 'code');

	assert.equal(isCancellation({ name: 'AbortError', code: 'ABORT_ERR' }), true);
	assert.equal(isCancellation({ message: 'aborted', signal: { aborted: true } }), true);
	assert.equal(cancellationOf({ signal: { aborted: true } }).matchedBy, 'signal');
	assert.equal(isCancellation({ signal: { aborted: false } }), false);
});

test('accepts the two codes alpha adds without a version check', () => {
	assert.deepEqual(LEGACY_CANCELLATION_CODES, ['ABORT_ERR']);
	assert.deepEqual(ALPHA_CANCELLATION_CODES, ['ABORTED', 'ABORTED_BEFORE_DISPATCH']);
	assert.deepEqual(CANCELLATION_CODES, ['ABORT_ERR', 'ABORTED', 'ABORTED_BEFORE_DISPATCH']);

	for (const code of ALPHA_CANCELLATION_CODES) {
		assert.equal(isCancellationCode(code), true, code + ' must be a cancellation code');
		assert.equal(isCancellation({ code }), true, code + ' on the error itself');
	}

	// The real alpha shape: toolErrorResult(error, { name, code }) puts the pair
	// under error.info, so the plugin sees it there even when the outer error is
	// the caller's own unclassified error.
	const relabelled = { message: 'spawn failed', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } };
	const info = cancellationOf(relabelled);
	assert.equal(info.cancelled, true);
	assert.equal(info.matchedBy, 'info.code');
	assert.equal(info.code, 'ABORTED_BEFORE_DISPATCH');
	assert.equal(info.name, 'AbortError', 'the reported name still comes from the info layer');
	assert.equal(cancellationOf({ info: { name: 'AbortError' } }).matchedBy, 'info.name');
});

test('the three cancellation codes all take the cancellation path', () => {
	const shapes = [
		['AbortError name (rc.5)', { name: 'AbortError', message: 'aborted' }],
		['ABORTED (alpha, body invoked)', { name: 'AbortError', code: 'ABORTED', message: 'aborted' }],
		['ABORTED_BEFORE_DISPATCH (alpha, body not invoked)', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH', message: 'aborted' }],
		['ABORT_ERR (legacy code)', { code: 'ABORT_ERR', message: 'aborted' }],
		['info-wrapped ABORTED', { message: 'aborted', info: { name: 'AbortError', code: 'ABORTED' } }],
	];
	for (const [label, error] of shapes) {
		const { outcome, written, recorded } = capture(error);
		assert.equal(outcome.cancelled, true, label + ' must be classified as a cancellation');
		assert.equal(outcome.diagnosticKind, 'host-cancelled', label);
		assert.match(outcome.message, /^\[ps51\] cancelled while the resident host was running; the command was not retried: /, label);
		assert.equal(written.length, 1, label + ' must write exactly one line');
		assert.equal(recorded.length, 1, label + ' must record exactly one diagnostic');
		assert.equal(recorded[0].kind, 'host-cancelled', label);
		assert.equal(recorded[0].error, 'aborted', label + ' keeps the raw error text');
	}
});

test('ordinary failures still take the failure path', () => {
	const ordinary = [
		new Error('host closed the connection before the exit frame'),
		Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
		{ code: 'ECONNRESET', message: 'socket hang up' },
		{ name: 'SubprocessError', code: 'SUBPROCESS_SPAWN_FAILED', message: 'spawn failed' },
		{ name: 'Error', message: 'boom' },
	];
	for (const error of ordinary) {
		assert.equal(isCancellation(error), false, textOf(error) + ' must stay a failure');
		const { outcome, written, recorded } = capture(error);
		assert.equal(outcome.cancelled, false, textOf(error));
		assert.equal(outcome.diagnosticKind, 'host-failed', textOf(error));
		// The wording rc.5 produced for this branch stays byte for byte.
		assert.equal(
			outcome.message,
			'[ps51] resident host failed after the command was sent and was not retried: ' + textOf(error)
		);
		assert.equal(written.length, 1);
		assert.equal(recorded[0].kind, 'host-failed');
	}
});

test('classification never throws on values that are not errors', () => {
	const values = [null, undefined, 0, 42, '', 'plain text', [], Symbol('abort')];
	for (const value of values) {
		assert.doesNotThrow(() => cancellationOf(value));
		assert.equal(isCancellation(value), false);
	}
	assert.equal(textOf(null), 'no error detail');
	assert.equal(textOf('plain text'), 'plain text');
	assert.equal(textOf(new Error('boom')), 'boom');
});

test('matching is case-insensitive but still limited to known values', () => {
	assert.equal(isCancellationCode('aborted'), true);
	assert.equal(isCancellationCode('ABORT'), false);
	assert.equal(isCancellationName('aborterror'), true);
	assert.equal(isCancellationName('Abort'), false);
	assert.equal(isCancellation({ code: 'ABORTED_BY_USER' }), false);
});

test('a plain failure after send still exits 125 and is never retried', { skip: process.platform !== 'win32' }, async () => {
	// The same fake host as the no-replay test: accept the frame, then vanish.
	// This pins the wiring in lib/client.js: an ordinary failure must keep the
	// old wording and the old diagnostics kind, not the new cancellation one.
	const pipe = 'ps51-cancel-classify-' + process.pid + '-' + Math.random().toString(16).slice(2, 8);
	const runtime = mkdtempSync(join(tmpdir(), 'ps51-cancel-classify-'));
	let server;
	try {
		server = createServer((socket) => socket.once('data', () => socket.destroy()));
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
					PS51_DIAGNOSTICS: '1',
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

		assert.equal(code, 125, 'the exit code of this branch is unchanged: ' + stderr);
		assert.match(stderr, /\[ps51\] resident host failed after the command was sent and was not retried: /);
		assert.doesNotMatch(stderr, /\[ps51\] cancelled/, 'a plain failure must not be reported as a cancellation');
		assert.doesNotMatch(stdout, /hi/, 'the command must not run through a fallback spawn');

		const log = readFileSync(join(runtime, 'diagnostics.log'), 'utf8').trim().split('\n');
		const entry = JSON.parse(log[log.length - 1]);
		assert.equal(entry.kind, 'host-failed');
		assert.equal(entry.matchedBy, 'none');
		assert.equal(entry.error, 'host closed the connection before the exit frame');
	} finally {
		if (server) await new Promise((resolve) => server.close(resolve));
		rmSync(runtime, { recursive: true, force: true });
	}
});
