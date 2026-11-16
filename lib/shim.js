/**
 * BASH_ENV shim generator.
 *
 * DSH starts every bash command with BASH_ENV pointing at a shell file, so the
 * shim is the only place where a guard can see a command before bash expands
 * it. The generated file:
 *
 * 1. chain-loads the BASH_ENV that was active before this plugin (a shell can
 *    only have one, so every plugin has to cooperate);
 * 2. installs a DEBUG trap that remembers the raw command text;
 * 3. defines powershell / powershell.exe functions, but only when bash would
 *    otherwise have executed the 5.1 executable (another plugin's redirect to
 *    pwsh wins, per decision D3).
 */

/**
 * @param {{executable: string, node: string, client: string, hostScript: string, runtime: string, pipe: string, marker: string}} config
 * @returns {string} bash source for bash-env.sh
 */
export function buildShim(config) {
	const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
	const expected = String(config.executable).replace(/\\/g, '/').toLowerCase();
	return (
		'# dsh-ps51-guard: generated BASH_ENV shim (' + config.marker + ')\n' +
		'# Do not edit: it is rewritten every time the plugin starts.\n' +
		'if [ -n "$PS51_PREV_BASH_ENV" ] && [ -r "$PS51_PREV_BASH_ENV" ] && [ "$PS51_PREV_BASH_ENV" != "$BASH_ENV" ]; then\n' +
		'  . "$PS51_PREV_BASH_ENV"\n' +
		'fi\n' +
		'\n' +
		'if [ "${PS51_GUARD:-1}" = "0" ]; then\n' +
		'  return 0 2>/dev/null || exit 0\n' +
		'fi\n' +
		'\n' +
		'__ps51_node=' + quote(config.node) + '\n' +
		'__ps51_client=' + quote(config.client) + '\n' +
		'__ps51_host=' + quote(config.hostScript) + '\n' +
		'__ps51_exe=' + quote(config.executable) + '\n' +
		'__ps51_runtime=' + quote(config.runtime) + '\n' +
		'__ps51_pipe=' + quote(config.pipe) + '\n' +
		'__ps51_expected=' + quote(expected) + '\n' +
		'__ps51_expected=$(cygpath -u "$__ps51_expected" 2>/dev/null) || true\n' +
		'__ps51_expected=$(printf \'%s\' "$__ps51_expected" | tr \'A-Z\' \'a-z\')\n' +
		'\n' +
		'# Chain whatever DEBUG trap was already installed, so this shim does not\n' +
		'# silently disable another plugin that also watches commands.\n' +
		'__ps51_prev_trap=$(trap -p DEBUG 2>/dev/null)\n' +
		'__ps51_prev_hook=""\n' +
		'if [ -n "$__ps51_prev_trap" ]; then\n' +
		'  __ps51_prev_hook=${__ps51_prev_trap#trap -- \'}\n' +
		'  __ps51_prev_hook=${__ps51_prev_hook%\' DEBUG}\n' +
		'fi\n' +
		'\n' +
		'__ps51_debug_hook() {\n' +
		'  case "$BASH_COMMAND" in\n' +
		'    powershell|powershell.exe|powershell\\ *|powershell.exe\\ *|command\\ powershell*|command\\ powershell.exe*|*=*\\ powershell\\ *|*=*\\ powershell.exe\\ *)\n' +
		'      PS51_RAW="$BASH_COMMAND"\n' +
		'      # The client cannot see an unexported shell variable such as a\n' +
		'      # for-loop counter, so it gets the list of names bash has.\n' +
		'      PS51_BASH_VARS=$(compgen -v | tr "\\n" " ")\n' +
		'      export PS51_RAW PS51_BASH_VARS\n' +
		'      ;;\n' +
		'    *)\n' +
		'      unset PS51_RAW PS51_BASH_VARS 2>/dev/null\n' +
		'      ;;\n' +
		'  esac\n' +
		'  if [ -n "$__ps51_prev_hook" ]; then\n' +
		'    eval "$__ps51_prev_hook"\n' +
		'  fi\n' +
		'  return 0\n' +
		'}\n' +
		'\n' +
		'__ps51_invoke() {\n' +
		'  local __ps51_rc\n' +
		'  if [ -z "${PS51_RAW:-}" ]; then\n' +
		'    "$__ps51_exe" "$@"\n' +
		'    return $?\n' +
		'  fi\n' +
		'  PS51_EXE="$__ps51_exe" PS51_HOST_SCRIPT="$__ps51_host" PS51_RUNTIME="$__ps51_runtime" PS51_PIPE="$__ps51_pipe" \\\n' +
		'    "$__ps51_node" "$__ps51_client" powershell.exe "$@"\n' +
		'  __ps51_rc=$?\n' +
		'  unset PS51_RAW PS51_BASH_VARS 2>/dev/null\n' +
		'  return $__ps51_rc\n' +
		'}\n' +
		'\n' +
				'for __ps51_word in powershell powershell.exe; do\n' +
		'  if [ "$(type -t "$__ps51_word" 2>/dev/null)" = "function" ]; then\n' +
		'    continue\n' +
		'  fi\n' +
		'  __ps51_resolved=$(command -v "$__ps51_word" 2>/dev/null) || continue\n' +
		'  case "$__ps51_resolved" in\n' +
		'    /*) ;;\n' +
		'    *) __ps51_resolved=$(cygpath -u "$__ps51_resolved" 2>/dev/null) || continue ;;\n' +
		'  esac\n' +
		'  __ps51_resolved=$(printf \'%s\' "$__ps51_resolved" | tr \'A-Z\' \'a-z\')\n' +
		'  if [ "$__ps51_resolved" != "$__ps51_expected" ]; then\n' +
		'    continue\n' +
		'  fi\n' +
		'  eval "$__ps51_word() { __ps51_invoke \\"\\$@\\"; }"\n' +
		'done\n' +
		'unset __ps51_word\n' +
		'\n' +
		'trap \'__ps51_debug_hook\' DEBUG\n'
	);
}
