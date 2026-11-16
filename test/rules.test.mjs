/**
 * Rule and lexer unit tests.
 *
 * Every rule from ROADMAP.md gets a before/after case here, so a change in the
 * rewrite table shows up as a failing expectation instead of a silent change in
 * what the model's command does.
 */

import assert from 'node:assert/strict';

import { rewritePayload, matchingDetectionToken } from '../lib/rules.js';
import { lexCommand, classifyInvocation, expandPayloadWord } from '../lib/lexer.js';

let passed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {() => void} body
 */
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

/**
 * @param {string} payload
 * @param {string} rule
 * @returns {object}
 */
function eventOf(payload, rule) {
	const result = rewritePayload(payload);
	const event = result.events.find((entry) => entry.rule === rule);
	assert.ok(event, 'expected a ' + rule + ' event, got ' + JSON.stringify(result.events));
	return event;
}

test('R2 rewrites /dev/null to $null', () => {
	const result = rewritePayload('Write-Output kept 2>/dev/null');
	assert.equal(result.payload, 'Write-Output kept 2>$null');
	assert.equal(eventOf('Write-Output kept 2>/dev/null', 'R2').annotate, '2>/dev/null → 2>$null');
});

test('R2 keeps the file descriptor prefix', () => {
	assert.equal(rewritePayload('cmd 1>/dev/null').payload, 'cmd 1>$null');
});

test('R3 rewrites export into $env: assignment', () => {
	const result = rewritePayload("export FOO=bar; Write-Output $env:FOO");
	assert.equal(result.payload, "$env:FOO = 'bar'; Write-Output $env:FOO");
});

test('R3 keeps quoted values and escapes single quotes', () => {
	assert.equal(rewritePayload("export A='x y'").payload, "$env:A = 'x y'");
	assert.equal(rewritePayload("export B=it's").payload, "$env:B = 'it''s'");
});

test('R4 pins curl to curl.exe once', () => {
	const result = rewritePayload('curl --version');
	assert.equal(result.payload, 'curl.exe --version');
	assert.equal(rewritePayload('curl.exe --version').events.length, 0);
});

test('R5 nests Join-Path with three or more paths', () => {
	assert.equal(rewritePayload('Join-Path a b').payload, 'Join-Path a b');
	assert.equal(rewritePayload('Join-Path a b c').payload, 'Join-Path (Join-Path a b) c');
	assert.equal(rewritePayload('Join-Path a b c d').payload, 'Join-Path (Join-Path (Join-Path a b) c) d');
});

test('R5 leaves named parameters and parenthesized calls alone', () => {
	assert.equal(rewritePayload('Join-Path -Path C:/ -ChildPath foo').payload, 'Join-Path -Path C:/ -ChildPath foo');
	assert.equal(rewritePayload('Join-Path (Get-Location) a b').payload, 'Join-Path (Get-Location) a b');
});

test('R6 maps bash ls flags', () => {
	assert.equal(rewritePayload('ls -la').payload, 'Get-ChildItem -Force');
	assert.equal(rewritePayload('ls -l').payload, 'Get-ChildItem -Force');
	assert.equal(rewritePayload('ls -Z').payload, 'ls -Z');
});

test('R6 maps bash rm flags without widening the delete', () => {
	assert.equal(rewritePayload('rm -rf C:/x').payload, 'Remove-Item -Recurse -Force C:/x');
	assert.equal(rewritePayload('rm -r C:/x').payload, 'Remove-Item -Recurse C:/x');
	assert.equal(rewritePayload('rm -f C:/x').payload, 'Remove-Item -Force C:/x');
	assert.equal(rewritePayload('rm -x C:/x').payload, 'rm -x C:/x');
});

test('rules leave string literals and comments alone', () => {
	assert.equal(rewritePayload("Set-Content data.txt 'curl example.com'").payload, "Set-Content data.txt 'curl example.com'");
	assert.equal(rewritePayload('Write-Output "2>/dev/null"').payload, 'Write-Output "2>/dev/null"');
	assert.equal(rewritePayload('# curl a && b').payload, '# curl a && b');
	assert.equal(rewritePayload('Write-Output x 2>/dev/null').payload, 'Write-Output x 2>$null');
});

test('R7 only explains utf8NoBOM', () => {
	const result = rewritePayload("'x' | Out-File -Encoding utf8NoBOM out.txt");
	assert.match(result.payload, /utf8NoBOM/);
	const hint = result.hints.find((entry) => entry.rule === 'R7');
	assert.equal(hint.always, true);
	assert.match(hint.text, /WriteAllText/);
});

test('R8 explains 5.1 redirection encoding only in verbose mode', () => {
	const hint = rewritePayload('Write-Output hi > out.txt').hints.find((entry) => entry.rule === 'R8');
	assert.equal(hint.always, false);
});

test('R9 rejects bash control operators', () => {
	const result = rewritePayload('Write-Output a && Write-Output b');
	assert.match(result.payload, /&&/);
	const hint = result.hints.find((entry) => entry.rule === 'R9');
	assert.equal(hint.always, true);
	assert.match(hint.text, /if \(\$\?\)/);
});

test('R10 rejects null-coalescing and ternary', () => {
	assert.equal(rewritePayload("$x = $null ?? 'd'").hints.filter((entry) => entry.rule === 'R10').length, 1);
	assert.equal(rewritePayload("$x = $true ? 'a' : 'b'").hints.filter((entry) => entry.rule === 'R10').length, 1);
});

test('matchingDetectionToken only matches detection tokens', () => {
	assert.equal(matchingDetectionToken('The token && is not valid'), '&&');
	assert.equal(matchingDetectionToken('unexpected token ?'), null);
	assert.equal(matchingDetectionToken('utf8NoBOM is not in the set'), 'utf8NoBOM');
});

test('lexer splits the payload from bash redirections', () => {
	const { tokens } = lexCommand('powershell.exe -NoProfile -Command "Write-Output kept" 2>/dev/null');
	const invocation = classifyInvocation(tokens);
	assert.equal(invocation.kind, 'command');
	assert.equal(invocation.payloadValues.length, 1);
	assert.equal(invocation.payloadValues[0], 'Write-Output kept');
	assert.equal(invocation.redirections.length, 1);
});

test('lexer keeps PowerShell variables that bash never defined', () => {
	const { tokens } = lexCommand('powershell.exe -Command "Write-Output $env:TEMP"');
	const invocation = classifyInvocation(tokens);
	const expanded = expandPayloadWord(invocation.payloadTokens[0], {
		bindingLookup: () => ({ found: false, value: '' }),
		expandedValue: 'Write-Output :TEMP',
	});
	assert.equal(expanded.text, 'Write-Output $env:TEMP');
	assert.ok(!expanded.fallback);
});

test('lexer expands bash variables that are defined', () => {
	const { tokens } = lexCommand('powershell.exe -Command "Write-Output $NAME"');
	const invocation = classifyInvocation(tokens);
	const expanded = expandPayloadWord(invocation.payloadTokens[0], {
		bindingLookup: (name) => ({ found: name === 'NAME', value: 'hello' }),
		expandedValue: 'Write-Output hello',
	});
	assert.equal(expanded.text, 'Write-Output hello');
});

test('lexer treats a bash loop counter as bash when no PowerShell name is in the word', () => {
	const { tokens } = lexCommand('powershell.exe -Command "Write-Output $i"');
	const invocation = classifyInvocation(tokens);
	const expanded = expandPayloadWord(invocation.payloadTokens[0], {
		bindingLookup: () => ({ found: false, value: '' }),
		expandedValue: 'Write-Output 7',
		shellVariables: new Set(['i', 'HOME']),
	});
	assert.equal(expanded.text, 'Write-Output 7');
	assert.equal(expanded.events[0].action, 'bash-expand');
});

test('lexer keeps PowerShell variables literal when other shell names exist', () => {
	const { tokens } = lexCommand('powershell.exe -Command "Write-Output $env:TEMP"');
	const invocation = classifyInvocation(tokens);
	const expanded = expandPayloadWord(invocation.payloadTokens[0], {
		bindingLookup: () => ({ found: false, value: '' }),
		expandedValue: 'Write-Output :TEMP',
		shellVariables: new Set(['i', 'HOME']),
	});
	assert.equal(expanded.text, 'Write-Output $env:TEMP');
});

test('lexer recognises -File and -EncodedCommand modes', () => {
	const file = classifyInvocation(lexCommand('powershell.exe -File build.ps1').tokens);
	assert.equal(file.kind, 'file');
	const encoded = classifyInvocation(lexCommand('powershell.exe -EncodedCommand VwByAA==').tokens);
	assert.equal(encoded.kind, 'encodedCommand');
});

console.log('rules: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length > 0) process.exitCode = 1;
