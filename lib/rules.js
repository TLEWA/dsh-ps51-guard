/**
 * Rewrite rules for PowerShell 5.1 payloads.
 *
 * rules.js works on the payload text only: the bash-visible parts of the
 * command (quoting, redirections, pipelines) are handled by lexer.js and the
 * shim. Each rule either rewrites the text (low risk, semantics preserved) or
 * only annotates it (medium and high risk, where a silent rewrite would change
 * what the model asked for).
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
	let text = payload;
	const events = [];
	const hints = [];
	const push = (rule, detail, risk, annotate) => events.push({ rule, detail, risk, annotate });

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
	const r5 = rewriteJoinPath(text, push);
	text = r5;

	// R6: bash shaped ls/rm invocations.
	const r6 = rewriteLsRm(text, push);
	text = r6;

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

	return { payload: text, events, hints };
}

/**
 * Nest Join-Path calls that pass more than two positional paths.
 * @param {string} text
 * @param {(rule: string, detail: string, risk: string) => void} push
 * @returns {string}
 */
function rewriteJoinPath(text, push) {
	return text.replace(/(?<![A-Za-z0-9_.-])Join-Path\b([^;|\n]*)/g, (whole, rest) => {
		const args = splitArguments(rest);
		if (args.length < 3) return whole;
		let nested = args[0];
		for (let i = 1; i < args.length; i += 1) {
			nested = i === 1 ? 'Join-Path ' + nested + ' ' + args[i] : 'Join-Path (' + nested + ') ' + args[i];
		}
		push('R5', 'Join-Path with ' + args.length + ' positional arguments nested into two-argument calls', 'low', whole.trim() + ' → ' + nested);
		return nested;
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
		if (ch === '"' || ch === '\'') {
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
 * @param {string} text
 * @param {(rule: string, detail: string, risk: string) => void} push
 * @returns {string}
 */
function rewriteLsRm(text, push) {
	let out = text.replace(
		/(?<![A-Za-z0-9_.-])ls\s+(-[A-Za-z]+)(?=\s|$)/g,
		(_match, flags) => {
			const letters = flags.slice(1).split('');
			const known = new Set(['l', 'a', 'h']);
			if (!letters.every((letter) => known.has(letter))) return _match;
			const mapped = letters.includes('a') || letters.includes('l') ? 'Get-ChildItem -Force' : 'Get-ChildItem';
			push('R6', 'ls ' + flags + ' rewritten to ' + mapped, 'medium', 'ls ' + flags + ' → ' + mapped);
			return mapped;
		}
	);
	out = out.replace(
		/(?<![A-Za-z0-9_.-])rm\s+-([A-Za-z]+)(?=\s|$)/g,
		(_match, flags) => {
			const letters = flags.slice(1).split('');
			const known = new Set(['r', 'f', 'R']);
			if (!letters.every((letter) => known.has(letter))) return _match;
			push('R6', 'rm -' + flags + ' rewritten to Remove-Item -Recurse -Force', 'medium', 'rm -' + flags + ' → Remove-Item -Recurse -Force');
			return 'Remove-Item -Recurse -Force';
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
