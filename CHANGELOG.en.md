# Changelog

Notable changes to this project are recorded here, kept in sync across both languages.

## 0.1.0 - 2026-11-16

### Added

- Repository scaffolding: `package.json`, `cordis.patch.yml`, `AGENTS.md`, bilingual docs and the MIT LICENSE.
- Wiring to the shared `TLEWA/dsh-plugin-ci` pipeline: verify, `pr-guard`, drift patrol and tag-driven release.
- The guard itself: injects `BASH_ENV` and chains any previous value; captures the pre-expansion `$BASH_COMMAND` from the `DEBUG` trap; takes over only calls that finally resolve to PowerShell 5.1, while `pwsh` and functions installed by other plugins pass through; decides bash versus PowerShell variable ownership (R1); forwards caller stdin (scripts can read `[Console]::In`) and restores a complete per-request environment snapshot (variables unset by the caller are removed from the host too); rewrites R2–R6 automatically (`2>/dev/null`, `export`, `curl`, `Join-Path`, `ls -la`/`rm -rf`); R7–R10 only suggest alternatives; every rewrite prints a `[ps51] A → B` annotation.
- A resident PowerShell 5.1 host: named pipe with length-prefixed JSON frames; exits after 10 idle minutes, rebuilds on demand, restarts after a crash or timeout; reuses one runspace, passes output through as raw bytes (`[Console]::Out/Error` is returned separately as raw bytes), derives the exit code from the script's final `$?`, and aborts the host when the client disconnects or cancels. Scripts containing the `exit` keyword run in a one-shot process so the code stays exact.
- Absorbed the `powershell → pwsh 7` redirect that used to live in `dsh-pwsh7-bash`: on by default, disabled with `PS51_PWSH7=0`, and `PS51_PWSH7_PATH` can pin `pwsh.exe`; only command words that finally resolve to 5.1 (or do not exist yet) are taken over, and existing functions, aliases and `PATH` wrappers are never overridden; `PS51_GUARD=0` disables both the guard and the redirect.
- Fixed the redirect function pasting the pwsh path directly into the `eval` source: it now calls through the `__ps51_pwsh7` variable, so paths containing `$` or backticks are neither expanded nor executed. Added a regression test.
- Configuration switches `PS51_GUARD`, `PS51_PWSH7`, `PS51_PWSH7_PATH`, `PS51_MODE`, `PS51_STRICT`, `PS51_VERBOSE`, `PS51_DIAGNOSTICS`, `PS51_SPAWN_GUARD` plus a JSON-lines diagnostics log.
- Added a `subprocess.spawn` injection (`PS51_SPAWN_GUARD=1` by default): the shim is written into the final spawn environment and any existing `BASH_ENV` is chained, so another plugin overwriting the process-wide `BASH_ENV` after this one no longer disables the guard. An explicit empty `BASH_ENV` and `PS51_GUARD=0` are still respected. Added 29 bridge unit tests (chain file, path equivalence, wrapper lifecycle and disposal transparency).
- Tests: rule unit tests, 33 real command corpus cases executed end-to-end through the shim, 8 redirect integration tests (including the path-metacharacter regression), and a 200-execution host stability and latency run; `docs/measurements.md` records the M0 baseline, latency and exit-code semantics.

### Notes

- This is an unreleased 0.1.0 development version; the version number and release timing are up to the maintainer.
- Migration: after switching the desktop profile to this plugin, remove and delete `dsh-pwsh7-bash` so two `BASH_ENV` providers do not overwrite each other.
- Known limitations: absolute-path calls and commands inside `cmd /c` cannot be intercepted; `-File` and `-EncodedCommand` pass through untouched; the redirect is installed at bash startup, so `command powershell` and absolute paths bypass it.
