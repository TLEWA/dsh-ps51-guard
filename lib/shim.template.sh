# dsh-ps51-guard: generated BASH_ENV shim (@@MARKER@@)
# Do not edit: it is rewritten every time the plugin starts.
# A chain file may itself include this shim (another plugin can preserve
# BASH_ENV that way). The sentinel stops that cycle; it is not exported, so it
# never reaches the command's own child processes.
if [ -n "$PS51_PREV_BASH_ENV" ] && [ -r "$PS51_PREV_BASH_ENV" ] && [ "$PS51_PREV_BASH_ENV" != "$BASH_ENV" ] && [ -z "@@DL@@PS51_BASH_ENV_CHAINING:-}" ]; then
  PS51_BASH_ENV_CHAINING=1
  . "$PS51_PREV_BASH_ENV"
  unset PS51_BASH_ENV_CHAINING
fi

if [ "@@DL@@PS51_GUARD:-1}" = "0" ]; then
  return 0 2>/dev/null || exit 0
fi

__ps51_node=@@NODE@@
__ps51_client=@@CLIENT@@
__ps51_host=@@HOST@@
__ps51_exe=@@EXE@@
__ps51_runtime=@@RUNTIME@@
__ps51_pipe=@@PIPE@@
__ps51_expected=@@EXPECTED@@
__ps51_expected=$(cygpath -u "$__ps51_expected" 2>/dev/null) || true
__ps51_expected=$(printf '%s' "$__ps51_expected" | tr 'A-Z' 'a-z')
__ps51_guard=@@GUARD@@
__ps51_pwsh7=@@PWSH7@@

# Optional redirect: only take a command word when bash would otherwise
# execute the 5.1 executable (or when no command exists at all). A PATH
# wrapper or a function from another plugin is left alone.
if [ -n "$__ps51_pwsh7" ] && [ "@@DL@@PS51_PWSH7:-1}" != "0" ]; then
  for __ps51_word in powershell powershell.exe; do
    if [ "$(type -t "$__ps51_word" 2>/dev/null)" = "function" ]; then
      continue
    fi
    __ps51_resolved=$(command -v "$__ps51_word" 2>/dev/null) || __ps51_resolved=""
    if [ -n "$__ps51_resolved" ]; then
      case "$__ps51_resolved" in
        /*) ;;
        *) __ps51_resolved=$(cygpath -u "$__ps51_resolved" 2>/dev/null) || continue ;;
      esac
      __ps51_resolved=$(printf '%s' "$__ps51_resolved" | tr 'A-Z' 'a-z')
      if [ "$__ps51_resolved" != "$__ps51_expected" ]; then
        continue
      fi
    fi
    eval "$__ps51_word() { @@PWSH7@@ \"\$@\"; }"
  done
  unset __ps51_word __ps51_resolved
fi

# Chain whatever DEBUG trap was already installed, so this shim does not
# silently disable another plugin that also watches commands.
__ps51_prev_trap=$(trap -p DEBUG 2>/dev/null)
__ps51_prev_hook=""
if [ -n "$__ps51_prev_trap" ]; then
  __ps51_prev_hook=@@DL@@__ps51_prev_trap#trap -- '}
  __ps51_prev_hook=@@DL@@__ps51_prev_hook%' DEBUG}
fi

__ps51_debug_hook() {
  case "$BASH_COMMAND" in
    powershell|powershell.exe|powershell\ *|powershell.exe\ *|command\ powershell*|command\ powershell.exe*|*=*\ powershell\ *|*=*\ powershell.exe\ *)
      PS51_RAW="$BASH_COMMAND"
      # The client cannot see an unexported shell variable such as a
      # for-loop counter, so it gets the list of names bash has.
      PS51_BASH_VARS=$(compgen -v | tr "\\n" " ")
      export PS51_RAW PS51_BASH_VARS
      ;;
    *)
      unset PS51_RAW PS51_BASH_VARS 2>/dev/null
      ;;
  esac
  if [ -n "$__ps51_prev_hook" ]; then
    eval "$__ps51_prev_hook"
  fi
  return 0
}

__ps51_invoke() {
  local __ps51_rc
  if [ -z "@@DL@@PS51_RAW:-}" ]; then
    "$__ps51_exe" "$@"
    return $?
  fi
  PS51_EXE="$__ps51_exe" PS51_HOST_SCRIPT="$__ps51_host" PS51_RUNTIME="$__ps51_runtime" PS51_PIPE="$__ps51_pipe" "$__ps51_node" "$__ps51_client" powershell.exe "$@"
  __ps51_rc=$?
  unset PS51_RAW PS51_BASH_VARS 2>/dev/null
  return $__ps51_rc
}

if [ "$__ps51_guard" = "1" ]; then
  __ps51_guard_installed=0
  for __ps51_word in powershell powershell.exe; do
    if [ "$(type -t "$__ps51_word" 2>/dev/null)" = "function" ]; then
      continue
    fi
    __ps51_resolved=$(command -v "$__ps51_word" 2>/dev/null) || continue
    case "$__ps51_resolved" in
      /*) ;;
      *) __ps51_resolved=$(cygpath -u "$__ps51_resolved" 2>/dev/null) || continue ;;
    esac
    __ps51_resolved=$(printf '%s' "$__ps51_resolved" | tr 'A-Z' 'a-z')
    if [ "$__ps51_resolved" != "$__ps51_expected" ]; then
      continue
    fi
    eval "$__ps51_word() { __ps51_invoke \"\$@\"; }"
    __ps51_guard_installed=1
  done
  unset __ps51_word __ps51_resolved
  if [ "$__ps51_guard_installed" = "1" ]; then
    trap '__ps51_debug_hook' DEBUG
  fi
fi
