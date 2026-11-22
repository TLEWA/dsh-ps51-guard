#!/usr/bin/env node
/**
 * dsh-ps51-guard client.
 *
 * The bash shim exports the raw command text and calls this file with the
 * already expanded arguments. The client rebuilds the PowerShell payload from
 * the raw text (so PowerShell variables survive), applies the rewrite rules,
 * and sends the result to the resident host. Anything unexpected falls back to
 * a plain powershell.exe spawn with the original arguments, which is exactly
 * the behaviour without the guard.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lexCommand, classifyInvocation, expandPayloadWord } from './lexer.js';
import { rewritePayload, matchingDetectionToken } from './rules.js';
import { encodeFrame, FrameDecoder } from './frames.js';
import { pipePath, spawnHost, killHost } from './host-control.js';
import { cancellationOf, reportHostFailure } from './cancellation.js';

const DEFAULT_TIMEOUT_MS = 300000;

function setting(name, fallback) {
	const value = process.env[name];
	return value === undefined || value === '' ? fallback : value;
}

function runtimeDir() {
	return setting('PS51_RUNTIME', process.cwd());
}

/**
 * Append one diagnostics record. Diagnostics never go to the command's own
 * stderr, so they cannot change what the model sees as command output.
 * @param {object} entry
 */
export function recordDiagnostic(entry) {
	if (setting('PS51_DIAGNOSTICS', '1') === '0') return;
	try {
		const file = join(runtimeDir(), 'diagnostics.log');
		appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
	} catch {
		// diagnostics are best effort
	}
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string} label
 * @returns {never}
 */
class FallbackSignal extends Error {}

function runDirect(executable, args) {
	const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
	child.on('error', (error) => {
		process.stderr.write('[ps51] fallback spawn failed: ' + error.message + '\n');
		process.exit(127);
	});
	child.on('exit', (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code === null ? 1 : code);
	});
	throw new FallbackSignal('fallback');
}

/**
 * Send one exec request to the host and relay its frames.
 * @returns {Promise<{code: number, parseError: string | null}>}
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Connect to the host pipe, retrying briefly: the host closes its listener
 * between connections, so an immediate connect can race with the accept loop.
 */
async function openPipe(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await new Promise((resolve, reject) => {
				const socket = connect(pipePath(pipeName()));
				socket.once('connect', () => resolve(socket));
				socket.once('error', reject);
			});
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await sleep(50);
		}
	}
}

async function execViaHost(socket, payload, timeoutMs, stdinB64) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer = null;
		const decoder = new FrameDecoder();
		const sink = { out: (buffer) => process.stdout.write(buffer), err: (buffer) => process.stderr.write(buffer) };

		const fail = (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.destroy();
			reject(error);
		};

		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			killHost(runtimeDir());
			process.stderr.write('[ps51] resident host timed out after ' + timeoutMs + ' ms and was stopped; the command was not retried\n');
			process.exit(124);
		}, timeoutMs);

		// openPipe already waited for the connection, so write right away.
		socket.write(
			encodeFrame({
				id: 'c1',
				op: 'exec',
				script: payload,
				cwd: process.cwd(),
				env: shellEnv(),
				...(stdinB64 ? { stdinB64 } : {}),
			})
		);
		socket.on('data', (chunk) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				fail(error);
				return;
			}
			for (const frame of frames) {
				if (frame.type === 'out') sink.out(Buffer.from(frame.dataB64, 'base64'));
				else if (frame.type === 'err') sink.err(Buffer.from(frame.dataB64, 'base64'));
				else if (frame.type === 'exit') {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					socket.end();
					resolve({ code: frame.code, parseError: frame.parseError || null });
					return;
				}
			}
		});
		socket.on('error', fail);
		socket.on('close', () => {
			if (!settled) fail(new Error('host closed the connection before the exit frame'));
		});
	});
}

/**
 * Read this call's stdin so the host can expose it through [Console]::In.
 * Only called once the host connection exists: on a fallback the original
 * child must still inherit the untouched stdin.
 */
function readStdin() {
	if (process.stdin.isTTY) return '';
	try {
		const data = readFileSync(0);
		return data.length === 0 ? '' : data.toString('base64');
	} catch {
		return '';
	}
}

/** Environment handed to the host for this one call. */
function shellEnv() {
	const env = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith('PS51_')) continue;
		env[name] = value;
	}
	return env;
}

function pipeName() {
	return setting('PS51_PIPE', 'dsh-ps51-guard');
}

/**
 * Reuse the host the plugin started. A host spawned here only lives for this
 * one call (Windows tears down a child when its parent exits), so it is a last
 * resort, not the normal path.
 *
 * The common case is one connect: a first short attempt keeps a cold start from
 * waiting out a long timeout, and only a failed attempt spawns a host.
 */
async function connectHost(executable, hostScript) {
	try {
		return await openPipe(250);
	} catch {
		// no listener yet
	}
	spawnHost({ executable, hostScript, runtime: runtimeDir(), pipe: pipeName() });
	recordDiagnostic({ kind: 'host-spawn', pipe: pipeName(), executable });
	return await openPipe(4000);
}

async function main() {
	const executable = setting('PS51_EXE', '');
	const hostScript = setting('PS51_HOST_SCRIPT', '');
	const args = process.argv.slice(2);
	const commandWord = args.shift() || 'powershell.exe';
	const raw = process.env.PS51_RAW || '';
	const mode = setting('PS51_MODE', 'rewrite');
	const strict = setting('PS51_STRICT', '0') === '1';
	const timeoutMs = Number.parseInt(setting('PS51_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)), 10) || DEFAULT_TIMEOUT_MS;

	const direct = (reason) => {
		recordDiagnostic({ kind: 'fallback', reason, raw, commandWord });
		runDirect(executable || commandWord, args, reason);
	};

	if (!executable) direct('missing-executable');
	if (!hostScript) direct('missing-host-script');
	if (!raw) direct('missing-raw-command');
	if (mode === 'off') direct('mode-off');

	let invocation;
	try {
		invocation = classifyInvocation(lexCommand(raw).tokens);
	} catch (error) {
		direct('lex-failed: ' + error.message);
	}
	if (!invocation.found || invocation.kind !== 'command') direct('not-a-command-invocation: ' + invocation.kind);

	const payloadWords = invocation.payloadTokens;
	if (payloadWords.length === 0) direct('empty-payload');
	// The shim passes the arguments that follow the command word, so the
	// payload must sit at the same offset the raw text reports. A glob can
	// expand one raw word into several argv entries; the rebuilt payload would
	// then be wrong, and the original command is the safe answer.
	const prefixArgs = invocation.payloadPrefixArgs || 0;
	if (args.length !== prefixArgs + payloadWords.length) direct('argv-payload-mismatch');

	const expanded = args.slice(prefixArgs);
	// Exported shell variables are visible here; a bash for-loop variable is
	// not, so the shim also reports the shell's variable names.
	const shellVariables = new Set(
		(setting('PS51_BASH_VARS', '') || '').split(/\s+/).filter((item) => item.length > 0)
	);
	const lookup = (name) => ({
		found: shellVariables.has(name) || Object.prototype.hasOwnProperty.call(process.env, name),
		value: process.env[name] === undefined ? '' : process.env[name],
	});

	const pieces = [];
	const events = [];
	for (let i = 0; i < payloadWords.length; i += 1) {
		const expandedWord = expandPayloadWord(payloadWords[i], {
			bindingLookup: lookup,
			expandedValue: expanded[i],
			shellVariables,
		});
		events.push(...expandedWord.events);
		pieces.push(expandedWord.fallback ? expanded[i] : expandedWord.text);
	}
	const expandedPayload = pieces.join(' ');
	const rewritten = rewritePayload(expandedPayload);
	events.push(...rewritten.events);
	let payload = mode === 'annotate' ? expandedPayload : rewritten.payload;

	if (mode !== 'annotate') {
		for (const event of rewritten.events) {
			if (event.annotate) process.stderr.write('[ps51] ' + event.annotate + '\n');
		}
	}

	if (rewritten.hints.length > 0) {
		const verbose = setting('PS51_VERBOSE', '0') === '1';
		for (const hint of rewritten.hints) {
			// Reject rules and R7 always explain themselves: the command cannot
			// succeed as written, so the replacement is part of the result.
			if (!verbose && !hint.always) continue;
			process.stderr.write(hint.text + '\n');
		}
		if (strict) {
			recordDiagnostic({ kind: 'strict-block', raw, payload, events });
			process.stderr.write('[ps51] PS51_STRICT=1 blocked this command; rewrite it as suggested above\n');
			process.exit(2);
		}
	}

	// A runspace cannot report the exit code of a script that calls exit, so
	// those scripts keep the one-shot path where the code is exact.
	if (/(^|[^A-Za-z0-9_])exit([^A-Za-z0-9_]|$)/i.test(payload)) {
		recordDiagnostic({ kind: 'one-shot-exit', raw, payload, events });
		runDirect(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', payload], 'exit-keyword');
	}

	let socket;
	try {
		socket = await connectHost(executable, hostScript);
	} catch (error) {
		// Nothing has been sent yet, so replaying the original command is safe.
		recordDiagnostic({ kind: 'host-unavailable', raw, payload, events, error: error.message });
		direct('host-unavailable: ' + error.message);
	}

	let outcome;
	try {
		outcome = await execViaHost(socket, payload, timeoutMs, readStdin());
	} catch (error) {
		// The request may already have run. Replaying it could duplicate side
		// effects, so report the failure instead of spawning a second process.
		// A cancellation is described as one (rc.5: AbortError / ABORT_ERR,
		// alpha: ABORTED / ABORTED_BEFORE_DISPATCH) but keeps the same exit code
		// and the same no-replay rule, so the branch semantics do not change.
		reportHostFailure(error, {
			write: (text) => process.stderr.write(text + '\n'),
			record: (entry) => recordDiagnostic({ ...entry, raw, payload, events }),
		});
		process.exit(125);
	}
	if (outcome.parseError) {
		recordDiagnostic({
			kind: 'parse-error',
			raw,
			payload,
			events,
			token: matchingDetectionToken(outcome.parseError),
			parseError: outcome.parseError,
		});
	}

	recordDiagnostic({ kind: 'exec', raw, payload, events, code: outcome.code, parseError: outcome.parseError });
	process.exit(outcome.code);
}

main().catch((error) => {
	// A FallbackSignal only means a plain powershell.exe child took over; its
	// own exit handler decides the exit code, so stay alive and silent here.
	if (error instanceof FallbackSignal) return;
	const failure = cancellationOf(error);
	recordDiagnostic({ kind: failure.cancelled ? 'cancelled' : 'internal-error', matchedBy: failure.matchedBy, error: failure.message });
	process.stderr.write('[ps51] ' + (failure.cancelled ? 'cancelled' : 'internal error') + ': ' + failure.message + '\n');
	process.exit(1);
});
