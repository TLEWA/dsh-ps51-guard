/**
 * Rewrite rules for PowerShell 5.1 payloads.
 *
 * rules.js works on the payload text only: the bash-visible parts of the
 * command (quoting, redirections, pipelines) are handled by lexer.js and the
 * shim. Each rule either rewrites the text (low risk, semantics preserved) or
 * only annotates it (medium and high risk, where a silent rewrite would change
 * what the model asked for).
 *
 * Rewrites apply to PowerShell code only. String literals and comments are
 * masked before the rules run, so data such as 'curl example.com' is never
 * rewritten just because it looks like a command.
 *
 * Rule identifiers follow ROADMAP.md.
 */

const DETECTION_TOKENS = ['&&', '||', '??', '?:', 'utf8NoBOM'];

/**
 * Apply every rule to one payload.
 *
 * @param {string} payload PowerShell source after bash variable expansion
 * @returns {{payload: string, events: object[], hints: {rule: string, always: boolean, text: string}[]}}
 */
export function rewritePayload(payload) {
	const { masked, slots } = maskPowerShell(payload);
	let text = masked;
	const events = [];
	const hints = [];
	// Rule details quote the original text, not the mask placeholders.
	const unmasked = (value) => unmask(String(value), slots);
	const push = (rule, detail, risk, annotate) =>
		events.push({ rule, detail: unmasked(detail), risk, annotate: annotate ? unmasked(annotate) : annotate });

	// R2: bash redirection syntax inside the PowerShell payload.
	const r2 = text.replace(/([0-9]?)>\s*\/dev\/null/g, (_match, fd) => {
		const prefix = fd ? fd : '';
		push('R2', 'stderr/stdout redirect to /dev/null rewritten to $null', 'low', prefix + '>/dev/null → ' + prefix + '>$null');
		return prefix + '>$null';
	});
	text = r2;

	// R3: bash export syntax inside the PowerShell payload.
	const r3 = text.replace(/(^|[;\n]\s*)export\s+([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^;\s]+)/g, (_match, lead, name, value) => {
		const literal = /^["']/.test(value) ? value : "'" + value.replace(/'/g, "''") + "'";
		const replacement = '$env:' + name + ' = ' + literal;
		push('R3', 'export ' + name + '=' + value + ' rewritten to ' + replacement, 'low', 'export ' + name + '=' + value + ' → ' + replacement);
		return lead + replacement;
	});
	text = r3;

	// R4: 5.1 resolves curl to Invoke-WebRequest, which takes different args.
	const r4 = text.replace(/(?<![A-Za-z0-9_.\\/-])curl(?=\s)/g, () => {
		push('R4', 'curl rewritten to curl.exe', 'low', 'curl → curl.exe');
		return 'curl.exe';
	});
	text = r4;

	// R5: Join-Path accepts exactly two positional paths before 6.0.
	text = rewriteJoinPath(text, push);

	// R6: bash shaped ls/rm invocations.
	text = rewriteLsRm(text, push);

	// R7: 5.1 has no utf8NoBOM encoding and cannot take a UTF8Encoding object
	// from Out-File/Set-Content, so there is no faithful rewrite; annotate.
	if (/utf8NoBOM/.test(text)) {
		push('R7', 'utf8NoBOM is not available in 5.1; use [System.IO.File]::WriteAllText with UTF8Encoding($false)', 'high');
		hints.push({
			rule: 'R7',
			always: true,
			text:
				'[ps51] -Encoding utf8NoBOM has no equivalent in PowerShell 5.1 and was not rewritten.\n' +
				'        Use: [System.IO.File]::WriteAllText($path, ($content | Out-String), (New-Object System.Text.UTF8Encoding $false))',
		});
	}

	// R8: PowerShell 5.1 writes > redirections as UTF-16LE with a BOM.
	if (/(?<![0-9><])>\s*[^$|\s]/.test(text)) {
		push('R8', 'PS 5.1 > writes UTF-16LE with a BOM; UTF-8 needs Out-File -Encoding utf8 (BOM) or the .NET API', 'medium');
		hints.push({
			rule: 'R8',
			always: false,
			text:
				'[ps51] PowerShell 5.1 writes "> file" as UTF-16LE with a BOM.\n' +
				'        For UTF-8 with BOM use: Out-File -Encoding utf8 <path>\n' +
				'        For UTF-8 without BOM use: [System.IO.File]::WriteAllText(<path>, ($content | Out-String), (New-Object System.Text.UTF8Encoding $false))',
		});
	}

	// R9: bash control operators are not PowerShell 5.1 syntax.
	const r9 = /&&|\|\|/.exec(text);
	if (r9) {
		push('R9', 'control operator ' + r9[0] + ' is not supported by PowerShell 5.1', 'high');
		hints.push({
			rule: 'R9',
			always: true,
			text:
				'[ps51] "' + r9[0] + '" is not valid in PowerShell 5.1 and was not rewritten.\n' +
				'        Use: a; if ($?) { b }            # replaces a && b\n' +
				'        Use: a; if (-not $?) { b }       # replaces a || b',
		});
	}

	// R10: null-coalescing and ternary operators are 7.0 syntax.
	const r10 = /(\?\?|(?<![A-Za-z0-9_])\?[^:.])/.exec(text);
	if (r10 && /\?\?|\?[^:.]*:\s*\S/.test(text)) {
		push('R10', 'null-coalescing or ternary operator is not supported by PowerShell 5.1', 'high');
		hints.push({
			rule: 'R10',
			always: true,
			text:
				'[ps51] "??" and the ternary "?: " are PowerShell 7 syntax and were not rewritten.\n' +
				'        Use: if ($x) { $a } else { $b }\n' +
				'        Use: $v = if ($null -ne $x) { $x } else { $fallback }',
		});
	}

	return { payload: unmask(text, slots), events, hints };
}

/**
 * Replace the contents of PowerShell strings and comments with placeholders so
 * the rules cannot rewrite user data that merely looks like a command.
 *
 * @param {string} text
 * @returns {{masked: string, slots: string[]}}
 */
function maskPowerShell(text) {
	const slots = [];
	let masked = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			const read = readQuoted(text, i);
			masked += read.closed ? ch + '\u0001' + slots.length + '\u0001' + ch : ch + '\u0001' + slots.length + '\u0001';
			slots.push(read.content);
			i = read.next;
			continue;
		}
		if (ch === '<' && text[i + 1] === '#') {
			const end = text.indexOf('#>', i + 2);
			const stop = end < 0 ? text.length : end + 2;
			masked += '\u0002' + slots.length + '\u0002';
			slots.push(text.slice(i, stop));
			i = stop;
			continue;
		}
		if (ch === '#' && (i === 0 || /[\s;{}()|&,]/.test(text[i - 1]))) {
			let stop = text.indexOf('\n', i);
			if (stop < 0) stop = text.length;
			masked += '\u0002' + slots.length + '\u0002';
			slots.push(text.slice(i, stop));
			i = stop;
			continue;
		}
		masked += ch;
		i += 1;
	}
	return { masked, slots };
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {{content: string, closed: boolean, next: number}}
 */
function readQuoted(text, start) {
	const quote = text[start];
	let i = start + 1;
	let content = '';
	while (i < text.length) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") {
				if (text[i + 1] === "'") {
					content += "''";
					i += 2;
					continue;
				}
				return { content, closed: true, next: i + 1 };
			}
			content += ch;
			i += 1;
			continue;
		}
		if (ch === '`') {
			content += ch + (text[i + 1] ?? '');
			i += 2;
			continue;
		}
		if (ch === '"') return { content, closed: true, next: i + 1 };
		content += ch;
		i += 1;
	}
	return { content, closed: false, next: text.length };
}

/**
 * @param {string} text
 * @param {string[]} slots
 * @returns {string}
 */
function unmask(text, slots) {
	return text.replace(/\u0001(\d+)\u0001|\u0002(\d+)\u0002/g, (_match, stringIndex, commentIndex) => {
		const index = stringIndex === undefined ? commentIndex : stringIndex;
		return slots[Number(index)] ?? '';
	});
}

/**
 * Nest Join-Path calls that pass more than two positional paths.
 * @param {string} text
 * @param {(rule: string, detail: string, risk: string, annotate?: string) => void} push
 * @returns {string}
 */
function rewriteJoinPath(text, push) {
	return text.replace(/(?<![A-Za-z0-9_.-])Join-Path\b([^;|\n]*)/g, (whole, rest) => {
		// A trailing comment is not an argument; keep it after the rewritten call.
		const tail = /(\s*\u0002\d+\u0002\s*)$/.exec(rest);
		const body = tail ? rest.slice(0, tail.index) : rest;
		const args = splitArguments(body);
		if (args.length < 3) return whole;
		// Named parameters and parenthesized or subexpression arguments cannot be
		// mapped onto positional nesting without changing what they bind to.
		if (args.some((arg) => arg.startsWith('-') || /[()]/.test(arg))) return whole;
		let nested = args[0];
		for (let i = 1; i < args.length; i += 1) {
			nested = i === 1 ? 'Join-Path ' + nested + ' ' + args[i] : 'Join-Path (' + nested + ') ' + args[i];
		}
		const rewritten = nested + (tail ? ' ' + tail[1].trim() : '');
		push('R5', 'Join-Path with ' + args.length + ' positional arguments nested into two-argument calls', 'low', whole.trim() + ' → ' + rewritten);
		return rewritten;
	});
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitArguments(text) {
	const args = [];
	let current = '';
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.trim() !== '') args.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim() !== '') args.push(current.trim());
	return args;
}

/**
 * Map bash shaped ls/rm invocations onto the cmdlets they meant.
 *
 * The flags are mapped back one by one: rm -f must not become a recursive
 * delete, and an unknown flag is left alone instead of being guessed.
 *
 * @param {string} text
 * @param {(rule: string, detail: string, risk: string, annotate?: string) => void} push
 * @returns {string}
 */
function rewriteLsRm(text, push) {
	let out = text.replace(
		/(?<![A-Za-z0-9_.-])ls\s+-([A-Za-z]+)(?=\s|$)/g,
		(match, flags) => {
			const letters = flags.split('');
			const known = new Set(['l', 'a', 'h']);
			if (!letters.every((letter) => known.has(letter))) return match;
			const mapped = letters.includes('a') || letters.includes('l') ? 'Get-ChildItem -Force' : 'Get-ChildItem';
			push('R6', 'ls -' + flags + ' rewritten to ' + mapped, 'medium', 'ls -' + flags + ' → ' + mapped);
			return mapped;
		}
	);
	out = out.replace(
		/(?<![A-Za-z0-9_.-])rm\s+-([A-Za-z]+)(?=\s|$)/g,
		(match, flags) => {
			const letters = flags.split('');
			const known = new Set(['r', 'R', 'f']);
			if (!letters.every((letter) => known.has(letter))) return match;
			const recurse = letters.includes('r') || letters.includes('R');
			const force = letters.includes('f');
			const mapped = 'Remove-Item' + (recurse ? ' -Recurse' : '') + (force ? ' -Force' : '');
			push('R6', 'rm -' + flags + ' rewritten to ' + mapped, 'medium', 'rm -' + flags + ' → ' + mapped);
			return mapped;
		}
	);
	return out;
}

/**
 * Tokens whose parse errors may be caused by a rewrite we can retry once.
 * @param {string} message
 * @returns {string | null}
 */
export function matchingDetectionToken(message) {
	for (const token of DETECTION_TOKENS) {
		if (message.includes(token)) return token;
	}
	return null;
}
