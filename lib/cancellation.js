/**
 * Cancellation classification for the client's failure paths.
 *
 * DSH 0.2.2-rc.5 reports an aborted tool run as a real AbortError
 * (`name: 'AbortError'`, Node code `ABORT_ERR`). DSH 0.2.3-alpha.1 relabels an
 * unclassified error that escapes while the caller is already aborting:
 * `dsh-tools/src/pipeline.ts:335` calls `wrapperFailureResult` (`:339-345`),
 * which returns `toolErrorResult(error, { name: 'AbortError', code: state.bodyInvoked
 * ? TOOL_ABORTED : TOOL_ABORTED_BEFORE_DISPATCH })`. The tool result therefore
 * carries `error.info = { name: 'AbortError', code: 'ABORTED' | 'ABORTED_BEFORE_DISPATCH' }`
 * instead of the caller's own error name.
 *
 * The match is widened, never narrowed: the rc.5 shapes (AbortError name,
 * ABORT_ERR code, an aborted signal) keep matching, and the two alpha codes are
 * added on top. Classification only decides how a failure is described; exit
 * codes and the "never replay a sent command" rule stay unchanged.
 */

/** Node's own AbortError code, still produced by rc.5. */
export const LEGACY_CANCELLATION_CODES = ['ABORT_ERR'];

/** Codes added by DSH 0.2.3-alpha.1's wrapperFailureResult. */
export const ALPHA_CANCELLATION_CODES = ['ABORTED', 'ABORTED_BEFORE_DISPATCH'];

/** Every code that means "the caller cancelled", old and new. */
export const CANCELLATION_CODES = [...LEGACY_CANCELLATION_CODES, ...ALPHA_CANCELLATION_CODES];

/** Error names that mean the caller cancelled. */
export const CANCELLATION_NAMES = ['AbortError'];

/**
 * Read a name/code pair from one error layer.
 * @param {unknown} layer
 * @returns {{name: string, code: string}}
 */
function readLayer(layer) {
	const source = layer !== null && typeof layer === 'object' ? layer : {};
	const name = typeof source.name === 'string' ? source.name.trim() : '';
	const code = typeof source.code === 'string' ? source.code.trim() : '';
	return { name, code };
}

/**
 * Whether a code is one of the cancellation codes (case-insensitive).
 * @param {string} code
 * @returns {boolean}
 */
export function isCancellationCode(code) {
	if (typeof code !== 'string' || code.length === 0) return false;
	const normalised = code.toUpperCase();
	return CANCELLATION_CODES.includes(normalised);
}

/**
 * Whether a name is a cancellation name (case-insensitive).
 * @param {string} name
 * @returns {boolean}
 */
export function isCancellationName(name) {
	if (typeof name !== 'string' || name.length === 0) return false;
	const normalised = name.toLowerCase();
	return CANCELLATION_NAMES.some((item) => item.toLowerCase() === normalised);
}

/**
 * Classify an error as a cancellation or an ordinary failure.
 *
 * Lookup order is stable so the reported reason does not depend on which
 * shape happened to be filled in:
 *   1. the code on the error itself,
 *   2. the code on `error.info` (the ToolErrorInfo alpha attaches),
 *   3. the name on the error itself,
 *   4. the name on `error.info`,
 *   5. an aborted signal carried by the error.
 *
 * @param {unknown} error
 * @returns {{cancelled: boolean, matchedBy: 'code' | 'info.code' | 'name' | 'info.name' | 'signal' | 'none', name: string, code: string, message: string}}
 */
export function cancellationOf(error) {
	const isObject = error !== null && typeof error === 'object';
	const own = readLayer(error);
	const nested = readLayer(isObject ? error.info : undefined);
	const message = textOf(error);

	if (isCancellationCode(own.code)) {
		return { cancelled: true, matchedBy: 'code', name: own.name, code: own.code, message };
	}
	if (isCancellationCode(nested.code)) {
		return { cancelled: true, matchedBy: 'info.code', name: own.name || nested.name, code: nested.code, message };
	}
	if (isCancellationName(own.name)) {
		return { cancelled: true, matchedBy: 'name', name: own.name, code: own.code, message };
	}
	if (isCancellationName(nested.name)) {
		return { cancelled: true, matchedBy: 'info.name', name: nested.name, code: own.code || nested.code, message };
	}
	const signal = isObject ? error.signal : undefined;
	if (signal !== null && typeof signal === 'object' && signal.aborted === true) {
		return { cancelled: true, matchedBy: 'signal', name: own.name, code: own.code, message };
	}
	return { cancelled: false, matchedBy: 'none', name: own.name, code: own.code, message };
}

/**
 * Shorthand for callers that only need the boolean.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCancellation(error) {
	return cancellationOf(error).cancelled;
}

/**
 * Best-effort message for a value that may not be an Error.
 * @param {unknown} error
 * @returns {string}
 */
export function textOf(error) {
	if (error instanceof Error) return error.message;
	if (error === null || error === undefined) return 'no error detail';
	if (typeof error === 'string') return error;
	// alpha hands the failure over as a plain body, so the message can live on an
	// object that is not an Error instance.
	if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
		return error.message;
	}
	try {
		return String(error);
	} catch {
		return 'no error detail';
	}
}

/**
 * Describe a failure that happened after the request reached the host.
 *
 * The two outcomes differ only in wording and in the diagnostics kind: the
 * caller still exits with the same code, and the command is still never
 * replayed, so a cancellation cannot turn into a second execution.
 *
 * @param {unknown} error
 * @returns {{cancelled: boolean, diagnosticKind: 'host-cancelled' | 'host-failed', message: string, matchedBy: string, detail: string}}
 */
export function hostFailure(error) {
	const info = cancellationOf(error);
	if (info.cancelled) {
		return {
			cancelled: true,
			diagnosticKind: 'host-cancelled',
			matchedBy: info.matchedBy,
			detail: info.message,
			// The no-replay sentence is kept verbatim: a cancelled command was
			// also not retried, and the caller must not read it as a retry hint.
			message: '[ps51] cancelled while the resident host was running; the command was not retried: ' + info.message,
		};
	}
	return {
		cancelled: false,
		diagnosticKind: 'host-failed',
		matchedBy: info.matchedBy,
		detail: info.message,
		message: '[ps51] resident host failed after the command was sent and was not retried: ' + info.message,
	};
}

/**
 * Report a host failure through the caller's writers so the client keeps one
 * reporting path (and tests can exercise exactly that path).
 *
 * @param {unknown} error
 * @param {{write?: (text: string) => void, record?: (entry: object) => void}} [hooks]
 * @returns {{cancelled: boolean, diagnosticKind: 'host-cancelled' | 'host-failed', message: string, matchedBy: string}}
 */
export function reportHostFailure(error, hooks = {}) {
	const outcome = hostFailure(error);
	// `error` keeps the raw error text, the same field the diagnostics log had
	// before this change; the classification is additive.
	const entry = { kind: outcome.diagnosticKind, matchedBy: outcome.matchedBy, error: outcome.detail };
	try {
		hooks.record?.(entry);
	} catch {
		// diagnostics are best effort
	}
	try {
		hooks.write?.(outcome.message);
	} catch {
		// reporting a failure must not fail
	}
	return outcome;
}
