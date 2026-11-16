import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { apply, name } from '../lib/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

test('entry point keeps the Cordis contract', () => {
  assert.equal(name, 'dsh-ps51-guard');
  assert.equal(typeof apply, 'function');
});

test('manifest agrees with the bundle patch', () => {
  assert.equal(pkg.name, name);
  assert.equal(pkg.engines.node, '>=20');
  assert.ok(pkg.engines.dsh, 'top-level engines.dsh is required');
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(patch.includes("name: 'dsh-ps51-guard'"), 'bundle patch must mount this package');
});

test('local publish is blocked by the central gate', () => {
  assert.match(pkg.scripts.prepublishOnly, /dsh-ci-gate --prepublish/);
});
