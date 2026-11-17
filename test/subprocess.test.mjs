/**
 * subprocess bridge tests: pure BASH_ENV chain behavior plus the transparent
 * spawn wrapper lifecycle.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	chainFile,
	choosePreviousBashEnv,
	findEnvKey,
	isBashCommand,
	normalizePath,
	quote,
	withGuardEnv,
} from '../lib/bash-env.js';
import { installSubprocessBridge } from '../lib/subprocess-bridge.js';

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

const runtime = mkdtempSync(join(tmpdir(), 'ps51-subprocess-'));
const shimPath = join(runtime, 'bash-env.sh');
const bashSpec = (env) => ({ argv: ['bash', '-c', 'echo hi'], cwd: runtime, env: env ?? {} });

try {
	test('bash -c gets the shim and the input spec stays untouched', () => {
		const spec = bashSpec({ PATH: 'x' });
		const next = withGuardEnv(spec, { shimPath, runtime });
		assert.notEqual(next, spec);
		assert.equal(next.env.BASH_ENV, shimPath);
		assert.equal(spec.env.BASH_ENV, undefined);
		assert.equal(next.env.PATH, 'x');
	});

	test('a bash -c spec without env copies the base environment', () => {
		const spec = { argv: ['bash', '-c', 'echo hi'] };
		const next = withGuardEnv(spec, { shimPath, runtime, baseEnv: { PATH: 'from-base', PS51_PREV_BASH_ENV: '' } });
		assert.notEqual(next, spec);
		assert.equal(next.env.BASH_ENV, shimPath);
		assert.equal(next.env.PATH, 'from-base');
		assert.equal(spec.env, undefined);
	});

	test('a non-bash spec without env stays untouched even with a base environment', () => {
		const spec = { argv: ['node', 'x.js'] };
		assert.equal(withGuardEnv(spec, { shimPath, runtime, baseEnv: { PATH: 'from-base' } }), spec);
	});

	test('an existing BASH_ENV becomes a chain file, earlier shims keep their order', () => {
		const first = join(runtime, 'first.sh');
		const second = join(runtime, 'second.sh');
		const spec = bashSpec({ BASH_ENV: second, PS51_PREV_BASH_ENV: first });
		const next = withGuardEnv(spec, { shimPath, runtime });
		const chain = next.env.PS51_PREV_BASH_ENV;
		assert.ok(chain && chain !== shimPath);
		const source = readFileSync(chain, 'utf8');
		assert.ok(source.indexOf(first) < source.indexOf(second));
		assert.match(source, /if \[ -r /);
	});

	test('a single earlier shim is used directly, without a chain file', () => {
		const earlier = join(runtime, 'earlier.sh');
		const next = withGuardEnv(bashSpec({ BASH_ENV: earlier }), { shimPath, runtime });
		assert.equal(next.env.PS51_PREV_BASH_ENV, earlier);
	});

	test('an ambient BASH_ENV is chained when the spec has none', () => {
		const ambient = join(runtime, 'ambient.sh');
		const next = withGuardEnv(bashSpec({}), { shimPath, runtime, ambientBashEnv: ambient });
		assert.equal(next.env.PS51_PREV_BASH_ENV, ambient);
		assert.equal(next.env.BASH_ENV, shimPath);
	});

	test('an explicit empty BASH_ENV is respected', () => {
		const spec = bashSpec({ BASH_ENV: '' });
		assert.equal(withGuardEnv(spec, { shimPath, runtime }), spec);
	});

	test('PS51_GUARD=0 disables the spawn injection', () => {
		const spec = bashSpec({ PS51_GUARD: '0' });
		assert.equal(withGuardEnv(spec, { shimPath, runtime }), spec);
	});

	test('non-bash commands without BASH_ENV are left alone', () => {
		const spec = { argv: ['node', 'x.js'], env: { PATH: 'x' } };
		assert.equal(withGuardEnv(spec, { shimPath, runtime }), spec);
	});

	test('non-bash commands that carry BASH_ENV still get the shim', () => {
		const spec = { argv: ['node', 'x.js'], env: { BASH_ENV: 'old.sh' } };
		const next = withGuardEnv(spec, { shimPath, runtime });
		assert.equal(next.env.BASH_ENV, shimPath);
		assert.equal(next.env.PS51_PREV_BASH_ENV, 'old.sh');
	});

	test('a spec already pointed at the shim is returned unchanged', () => {
		const spec = bashSpec({ BASH_ENV: shimPath });
		assert.equal(withGuardEnv(spec, { shimPath, runtime }), spec);
	});

	test('a self-referential previous shim is removed instead of sourcing itself', () => {
		const spec = bashSpec({ BASH_ENV: shimPath, PS51_PREV_BASH_ENV: shimPath });
		const next = withGuardEnv(spec, { shimPath, runtime });
		assert.notEqual(next, spec);
		assert.equal(next.env.BASH_ENV, shimPath);
		assert.equal(findEnvKey(next.env, 'PS51_PREV_BASH_ENV'), undefined);
	});

	test('an MSYS spelling of the shim is not chained as an earlier shim', () => {
		if (process.platform !== 'win32') return;
		const msys = shimPath.replace(/^([A-Za-z]):[\\/]/, '/$1/').replace(/\\/g, '/');
		assert.equal(normalizePath(msys), normalizePath(shimPath));
		const spec = bashSpec({ BASH_ENV: msys });
		const next = withGuardEnv(spec, { shimPath, runtime });
		assert.equal(next, spec);
		assert.equal(findEnvKey(next.env, 'PS51_PREV_BASH_ENV'), undefined);
	});

	test('choosePreviousBashEnv prefers another shim and drops self references', () => {
		const other = join(runtime, 'other.sh');
		assert.equal(choosePreviousBashEnv(other, 'ignored.sh', shimPath), other);
		assert.equal(choosePreviousBashEnv(shimPath, other, shimPath), other);
		assert.equal(choosePreviousBashEnv(shimPath, shimPath, shimPath), undefined);
		assert.equal(choosePreviousBashEnv('', other, shimPath), other);
		assert.equal(choosePreviousBashEnv(undefined, undefined, shimPath), undefined);
	});

	test('a spec already pointed at the shim still chains an ambient earlier shim', () => {
		const earlier = join(runtime, 'ambient-earlier.sh');
		const spec = bashSpec({ BASH_ENV: shimPath });
		const next = withGuardEnv(spec, { shimPath, runtime, ambientBashEnv: earlier });
		assert.equal(next.env.BASH_ENV, shimPath);
		assert.equal(next.env.PS51_PREV_BASH_ENV, earlier);
	});

	test('environment names are case-insensitive and no duplicate spelling survives', () => {
		const spec = bashSpec({ bash_env: 'old.sh' });
		const next = withGuardEnv(spec, { shimPath, runtime });
		const keys = Object.keys(next.env).filter((key) => key.toLowerCase() === 'bash_env');
		assert.equal(keys.length, 1);
		assert.equal(next.env[keys[0]], shimPath);
		assert.equal(findEnvKey(next.env, 'BASH_ENV'), keys[0]);
	});

	test('single quotes are escaped for bash', () => {
		assert.equal(quote("a'b"), "'a'\\''b'");
		assert.equal(quote('a b'), "'a b'");
	});

	test('isBashCommand accepts the real bash forms and rejects the rest', () => {
		assert.equal(isBashCommand(['bash', '-c', 'x']), true);
		assert.equal(isBashCommand(['bash.exe', '-lc', 'x']), true);
		assert.equal(isBashCommand(['C:/Windows/System32/bash.exe', '-c', 'x']), true);
		assert.equal(isBashCommand(['niubash', '-c', 'x']), true);
		assert.equal(isBashCommand(['bash', 'script.sh']), false);
		assert.equal(isBashCommand(['bash', '-x', 'script.sh']), false);
		assert.equal(isBashCommand(['bashx', '-c', 'x']), false);
		assert.equal(isBashCommand(['powershell.exe', '-Command', 'x']), false);
		assert.equal(isBashCommand([]), false);
	});

	test('chainFile deduplicates paths and returns null for an empty list', () => {
		assert.equal(chainFile(runtime, []), null);
		const one = join(runtime, 'one.sh');
		assert.equal(chainFile(runtime, [one, one]), one);
		const two = join(runtime, 'two.sh');
		const file = chainFile(runtime, [one, two]);
		assert.ok(file && file !== one && file !== two);
		const source = readFileSync(file, 'utf8');
		assert.equal((source.match(/if \[ -r /g) ?? []).length, 2);
		assert.equal((source.match(/one\.sh/g) ?? []).length, 2);
		assert.equal((source.match(/two\.sh/g) ?? []).length, 2);
	});

	test('the bridge wraps spawn, keeps this and extra arguments, and restores', () => {
		const calls = [];
		const service = {
			spawn(spec, ...rest) {
				calls.push({ receiver: this, spec, rest });
				return 'spawn-result';
			},
		};
		const original = service.spawn;
		const effects = [];
		const warnings = [];
		let activate = null;
		const scope = {
			get(name) {
				return name === 'subprocess' ? service : undefined;
			},
			effect(fn) {
				effects.push(fn);
			},
		};
		const ctx = {
			inject(deps, callback) {
				assert.deepEqual(deps, ['subprocess']);
				activate = () => callback(scope);
			},
		};
		assert.equal(installSubprocessBridge(ctx, { shimPath, runtime, warn: (m) => warnings.push(m) }), true);
		assert.ok(activate);
		activate();
		assert.notEqual(service.spawn, original);
		assert.equal(service.__ps51GuardSubprocessBridged, true);
		const spec = bashSpec({});
		const result = service.spawn(spec, 'extra', 42);
		assert.equal(result, 'spawn-result');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].receiver, service);
		assert.deepEqual(calls[0].rest, ['extra', 42]);
		assert.equal(calls[0].spec.env.BASH_ENV, shimPath);
		assert.equal(effects.length, 1);
		const restore = effects[0]();
		assert.equal(typeof restore, 'function');
		restore();
		assert.equal(service.spawn, original);
		assert.equal(service.__ps51GuardSubprocessBridged, undefined);
		assert.deepEqual(warnings, []);
	});

	test('a second activation does not wrap the wrapper again', () => {
		const service = { spawn() {} };
		let activate = null;
		const effects = [];
		const scope = {
			get() {
				return service;
			},
			effect(fn) {
				effects.push(fn);
			},
		};
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		const wrapped = service.spawn;
		activate();
		assert.equal(service.spawn, wrapped);
		assert.equal(effects.length, 1);
	});

	test('the bridge accepts a service-shaped injection callback', () => {
		const seen = [];
		const effects = [];
		const service = {
			spawn(spec) { seen.push(spec); },
			effect(fn) { effects.push(fn); },
		};
		let activate = null;
		const ctx = { inject(deps, callback) { activate = () => callback(service); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		service.spawn(bashSpec({}));
		assert.equal(seen.length, 1);
		assert.equal(seen[0].env.BASH_ENV, shimPath);
	});

	test('disposal stays transparent when a later wrapper owns the top', () => {
		const seen = [];
		const service = { spawn(spec) { seen.push(spec); } };
		let activate = null;
		const effects = [];
		const scope = {
			get() { return service; },
			effect(fn) { effects.push(fn); },
		};
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		const wrapped = service.spawn;
		const outer = (spec) => spec;
		service.spawn = outer;
		const restore = effects[0]();
		restore();
		assert.equal(service.spawn, outer);
		assert.equal(service.__ps51GuardSubprocessBridged, undefined);
		wrapped(bashSpec({}));
		assert.equal(seen.length, 1);
		assert.equal(seen[0].env.BASH_ENV, undefined);
	});

	test('a frozen service is reported and left alone', () => {
		const service = { spawn() {} };
		Object.preventExtensions(service);
		let activate = null;
		const warnings = [];
		const scope = { get() { return service; }, effect() {} };
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		assert.equal(installSubprocessBridge(ctx, { shimPath, runtime, warn: (m) => warnings.push(m) }), true);
		activate();
		assert.equal(service.__ps51GuardSubprocessBridged, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /frozen/);
	});

	test('without ctx.inject the bridge reports that it is unavailable', () => {
		assert.equal(installSubprocessBridge({}, { shimPath, runtime }), false);
	});

	test('spawn errors pass through unchanged', () => {
		const service = { spawn() { throw new Error('boom'); } };
		let activate = null;
		const scope = { get() { return service; }, effect() {} };
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		assert.throws(() => service.spawn(bashSpec({})), /boom/);
	});

	test('non-target specs reach the original spawn by identity', () => {
		const calls = [];
		const service = { spawn(spec) { calls.push(spec); } };
		let activate = null;
		const scope = { get() { return service; }, effect() {} };
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		const spec = { argv: ['node', 'x.js'], env: { PATH: 'x' } };
		service.spawn(spec);
		assert.equal(calls[0], spec);
	});

	test('a scope without cleanup hooks rolls the wrapper back', () => {
		const service = { spawn() {} };
		const original = service.spawn;
		let activate = null;
		const warnings = [];
		const scope = { get() { return service; } };
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		assert.equal(installSubprocessBridge(ctx, { shimPath, runtime, warn: (m) => warnings.push(m) }), true);
		activate();
		assert.equal(service.spawn, original);
		assert.equal(service.__ps51GuardSubprocessBridged, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /cleanup/);
	});

	test('the scope.on fallback registers cleanup when effect is absent', () => {
		const service = { spawn() {} };
		let activate = null;
		let dispose = null;
		const scope = {
			get() { return service; },
			on(event, fn) {
				if (event === 'dispose') dispose = fn;
			},
		};
		const ctx = { inject(deps, callback) { activate = () => callback(scope); } };
		installSubprocessBridge(ctx, { shimPath, runtime });
		activate();
		assert.ok(dispose);
		const wrapped = service.spawn;
		dispose();
		assert.notEqual(service.spawn, wrapped);
	});
} finally {
	rmSync(runtime, { recursive: true, force: true });
}

console.log('subprocess: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length > 0) process.exitCode = 1;
