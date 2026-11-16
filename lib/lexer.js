/**
 * Bash lexer for the raw command text captured by the guard shim.
 *
 * The shim grabs BASH_COMMAND from a DEBUG trap, so what arrives here is the
 * command exactly as the model wrote it: quotes, escapes and redirections are
 * still present, and a bare variable reference has not been expanded yet. That
 * is the only way to tell a PowerShell variable (env:TEMP style) from a bash
 * variable that the model meant to expand.
 *
 * The lexer implements just enough bash to be faithful for the shapes people
 * actually type; anything it cannot model is reported as a fallback to the
 * already-expanded argv, never guessed.
 */

/** Segment kinds inside one shell word. */
export const PLAIN = 'plain';
export const SINGLE = 'single';
export const DOUBLE = 'double';

const SPACE = /[ \t]/;
const OPERATORS = ['&&', '||', '|', ';', '&'];

/**
 * Split a raw bash command into words, redirections and operators.
 * @param {string} raw
 * @returns {{tokens: object[]}}
 */
export function lexCommand(raw) {
	const tokens = [];
	let word = null;
	let i = 0;
	const length = raw.length;

	const addSeg = (kind, text) => {
		if (!word) word = { kind: 'word', segs: [] };
		if (text === '') return;
		const last = word.segs[word.segs.length - 1];
		if (last && last.kind === kind) last.text += text;
		else word.segs.push({ kind, text });
	};
	const flushWord = () => {
		if (word) {
			tokens.push(word);
			word = null;
		}
	};

	while (i < length) {
		const ch = raw[i];

		if (SPACE.test(ch)) {
			flushWord();
			i += 1;
			continue;
		}

		if (ch === '\\') {
			i += 1;
			if (i < length) addSeg(PLAIN, raw[i]);
			i += 1;
			continue;
		}

		if (ch === '\'') {
			const end = raw.indexOf('\'', i + 1);
			const stop = end === -1 ? length : end;
			addSeg(SINGLE, raw.slice(i + 1, stop));
			i = stop + 1;
			continue;
		}

		if (ch === '"') {
			let j = i + 1;
			let text = '';
			while (j < length && raw[j] !== '"') {
				if (raw[j] === '\\' && j + 1 < length) {
					text += raw[j] + raw[j + 1];
					j += 2;
					continue;
				}
				text += raw[j];
				j += 1;
			}
			addSeg(DOUBLE, text);
			i = j + 1;
			continue;
		}

		const redirect = matchRedirection(raw, i);
		if (redirect) {
			flushWord();
			tokens.push(redirect.token);
			i = redirect.next;
			continue;
		}

		const operator = OPERATORS.find((op) => raw.startsWith(op, i));
		if (operator) {
			flushWord();
			tokens.push({ kind: 'op', op: operator });
			i += operator.length;
			continue;
		}

		addSeg(PLAIN, ch);
		i += 1;
	}

	flushWord();
	return { tokens };
}

/**
 * Match a redirection operator at one offset.
 * @param {string} raw
 * @param {number} index
 * @returns {{token: object, next: number} | null}
 */
function matchRedirection(raw, index) {
	let i = index;
	let fd = null;
	while (i < raw.length && raw[i] >= '0' && raw[i] <= '9') i += 1;
	if (i > index) fd = raw.slice(index, i);

	if (raw.startsWith('&>', i)) {
		const target = readTarget(raw, i + 2);
		return { token: { kind: 'redir', fd, op: '&>', target: target.text }, next: target.next };
	}
	if (raw.startsWith('>&', i)) {
		const target = readTarget(raw, i + 2);
		return { token: { kind: 'redir', fd, op: '>&', target: target.text }, next: target.next };
	}
	if (raw[i] === '>' && raw[i + 1] === '>') {
		const target = readTarget(raw, i + 2);
		return { token: { kind: 'redir', fd, op: '>>', target: target.text }, next: target.next };
	}
	if (raw[i] === '>') {
		const target = readTarget(raw, i + 1);
		return { token: { kind: 'redir', fd, op: '>', target: target.text }, next: target.next };
	}
	if (raw[i] === '<') {
		const target = readTarget(raw, i + 1);
		return { token: { kind: 'redir', fd, op: '<', target: target.text }, next: target.next };
	}
	return null;
}

/**
 * @param {string} raw
 * @param {number} index
 * @returns {{text: string, next: number}}
 */
function readTarget(raw, index) {
	let i = index;
	while (i < raw.length && SPACE.test(raw[i])) i += 1;
	const start = i;
	while (i < raw.length && !SPACE.test(raw[i]) && !OPERATORS.some((op) => raw.startsWith(op, i))) i += 1;
	return { text: raw.slice(start, i), next: i };
}

/**
 * Join the segments of one word after quote removal, without expanding
 * anything. Used for the command word, switches and redirection targets, never
 * for the PowerShell payload.
 * @param {object} word
 * @returns {string}
 */
export function unquotedText(word) {
	if (!word || word.kind !== 'word') return '';
	return word.segs.map((seg) => seg.text).join('');
}

const PREFIX_WORDS = new Set(['command', 'exec']);

/** Switches of powershell.exe that take a value. */
const VALUE_SWITCHES = new Set([
	'-executionpolicy', '-ep', '-windowstyle', '-inputformat', '-outputformat',
	'-version', '-v', '-workingdirectory', '-wd', '-configurationname',
	'-psconsolefile', '-settingsfile', '-custompipename',
]);

/** Switches that are plain flags. */
const FLAG_SWITCHES = new Set([
	'-nologo', '-nol', '-noprofile', '-nop', '-noninteractive', '-noni',
	'-noexit', '-noe', '-sta', '-mta', '-login', '-l',
]);

/** Switches that consume the rest of the command line as their payload. */
const PAYLOAD_SWITCHES = new Map([
	['-command', 'command'],
	['-c', 'command'],
	['-encodedcommand', 'encodedCommand'],
	['-ec', 'encodedCommand'],
	['-enc', 'encodedCommand'],
	['-e', 'encodedCommand'],
	['-file', 'file'],
	['-f', 'file'],
]);

/**
 * Classify one powershell invocation.
 * @param {object[]} tokens token list from lexCommand
 * @returns {{found: boolean, commandWord: string, kind: string, payloadTokens: object[], payloadValues: string[], flags: string[], redirections: object[], assignments: string[]}}
 */
export function classifyInvocation(tokens) {
	const result = {
		found: false,
		commandWord: '',
		kind: 'none',
		payloadTokens: [],
		payloadValues: [],
		payloadPrefixArgs: 0,
		flags: [],
		redirections: [],
		assignments: [],
	};
	const words = tokens.filter((token) => token.kind !== 'op' && token.kind !== 'redir');
	for (const token of tokens) if (token.kind === 'redir') result.redirections.push(token);

	let index = 0;
	while (index < words.length && isAssignment(words[index])) {
		result.assignments.push(unquotedText(words[index]));
		index += 1;
	}
	while (index < words.length && PREFIX_WORDS.has(unquotedText(words[index]))) index += 1;
	if (index >= words.length) return result;

	result.commandWord = unquotedText(words[index]);
	result.found = true;
	index += 1;

	const rest = words.slice(index);
	for (let i = 0; i < rest.length; i += 1) {
		const value = unquotedText(rest[i]);
		const lower = value.toLowerCase();
		const kind = PAYLOAD_SWITCHES.get(lower);
		if (kind) {
			result.kind = kind;
			result.payloadTokens = rest.slice(i + 1);
			result.payloadValues = result.payloadTokens.map(unquotedText);
			// Index, inside the already expanded argv tail, of the first
			// payload word. The shim passes exactly the arguments after the
			// command word.
			result.payloadPrefixArgs = i + 1;
			return result;
		}
		if (FLAG_SWITCHES.has(lower)) {
			result.flags.push(value);
			continue;
		}
		if (VALUE_SWITCHES.has(lower)) {
			i += 1;
			continue;
		}
	}
	return result;
}

/**
 * @param {object} word
 * @returns {boolean}
 */
function isAssignment(word) {
	if (word.kind !== 'word' || word.segs.length === 0) return false;
	const first = word.segs[0];
	return first.kind === PLAIN && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text);
}

/**
 * Expand one payload word into the text PowerShell should receive.
 *
 * - a fully single-quoted word is taken verbatim (bash does not expand it);
 * - a fully double-quoted word keeps PowerShell variables literal unless bash
 *   defines a variable of that name (rule R1);
 * - a plain word, or a mixed word, uses the already-expanded argv value, which
 *   is exactly what an unguarded run would have passed to the executable.
 *
 * @param {object} word
 * @param {{bindingLookup: (name: string) => {found: boolean, value: string}, expandedValue: string}} context
 * @returns {{text: string, events: object[], fallback: string | null}}
 */
export function expandPayloadWord(word, context) {
	const { bindingLookup, expandedValue, shellVariables } = context;
	if (!word || word.kind !== 'word') return { text: expandedValue || '', events: [], fallback: null };

	const kinds = new Set(word.segs.map((seg) => seg.kind));
	if (kinds.size === 1 && kinds.has(SINGLE)) {
		return { text: word.segs[0].text, events: [], fallback: null };
	}
	if (kinds.size === 1 && kinds.has(DOUBLE)) {
		// A bash for-loop variable is not exported, so it never reaches this
		// process' environment; the shim therefore reports the shell variables
		// that exist. When a double-quoted word only mentions those, the argv
		// word bash already expanded is the right text.
		const names = variableNames(word.segs[0].text);
		if (shellVariables && shellVariables.size > 0 && names.length > 0) {
			const bashNames = names.filter((name) => shellVariables.has(name));
			const psNames = names.filter((name) => !shellVariables.has(name));
			if (bashNames.length > 0 && psNames.length === 0) {
				return {
					text: expandedValue ?? word.segs[0].text,
					events: [{ rule: 'R1', action: 'bash-expand', name: bashNames.join(',') }],
					fallback: null,
				};
			}
			if (bashNames.length > 0 && psNames.length > 0) {
				// Mixed ownership cannot be resolved without splitting the word,
				// so keep bash's expansion of the whole word (fail-open).
				return {
					text: expandedValue ?? word.segs[0].text,
					events: [{ rule: 'R1', action: 'mixed-variables', name: names.join(',') }],
					fallback: 'mixed-variables',
				};
			}
		}
		return expandDoubleQuoted(word.segs[0].text, bindingLookup);
	}
	return { text: expandedValue || unquotedText(word), events: [], fallback: 'plain-word' };
}

/**
 * Names of the plain $name / ${name} references in a double-quoted string,
 * skipping escaped dollars. Used to decide whether a word belongs to bash or
 * to PowerShell (rule R1).
 * @param {string} text
 * @returns {string[]}
 */
function variableNames(text) {
	const names = [];
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '\\') {
			i += 1;
			continue;
		}
		if (text[i] !== '$') continue;
		const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
		if (!match) continue;
		names.push(match[1]);
		i += match[0].length - 1;
	}
	return names;
}

const BACKTICK = 96;

/**
 * Rule R1: inside a double-quoted bash string keep a bare variable reference
 * literal when bash does not define it (the model meant PowerShell), and
 * substitute the bash value when bash does define it (the model meant bash).
 *
 * @param {string} text contents of the double-quoted string, backslash escapes intact
 * @param {(name: string) => {found: boolean, value: string}} bindingLookup
 * @returns {{text: string, events: object[], fallback: string | null}}
 */
export function expandDoubleQuoted(text, bindingLookup) {
	const events = [];
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\') {
			const next = text[i + 1];
			if (next === undefined) {
				out += '\\';
				i += 1;
				continue;
			}
			if (next === '$' || next === '"' || next === '\\' || next.charCodeAt(0) === BACKTICK) {
				out += next;
				i += 2;
				continue;
			}
			if (next === '\n') {
				i += 2;
				continue;
			}
			out += ch + next;
			i += 2;
			continue;
		}
		if (ch.charCodeAt(0) === BACKTICK) return { text, events, fallback: 'backtick' };
		if (ch === '$') {
			const rest = text.slice(i);
			if (rest.startsWith('$(')) return { text, events, fallback: 'command-substitution' };
			let match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
			let consumed = match ? match[0].length : 0;
			if (!match) {
				match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
				consumed = match ? match[0].length : 0;
			}
			if (match) {
				const found = bindingLookup(match[1]);
				if (found.found) {
					out += found.value;
					events.push({ rule: 'R1', name: match[1], action: 'expand' });
				} else {
					out += match[0];
					events.push({ rule: 'R1', name: match[1], action: 'keep' });
				}
				i += consumed;
				continue;
			}
			if (rest.startsWith('$' + '{')) return { text, events, fallback: 'brace-expansion' };
			if (/^\$[0-9@*#?$!_-]/.test(rest)) return { text, events, fallback: 'special-parameter' };
			out += '$';
			i += 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	return { text: out, events, fallback: null };
}
