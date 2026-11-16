# Changelog

Notable changes to this project are recorded here, kept in sync across both languages.

## 0.1.0 - 2026-11-16

### Added

- Repository scaffolding: `package.json`, `cordis.patch.yml`, `AGENTS.md`, bilingual docs and the MIT LICENSE.
- Wiring to the shared `TLEWA/dsh-plugin-ci` pipeline: verify, `pr-guard`, drift patrol and tag-driven release.
- The guard itself: injects `BASH_ENV` and chains any previous value; captures the pre-expansion `$BASH_COMMAND` from the `DEBUG` trap; takes over only calls that finally resolve to PowerShell 5.1, while `pwsh` and functions installed by other plugins pass through; decides bash versus PowerShell variable ownership (R1); forwards caller stdin (scripts can read `[Console]::In`) and restores a complete per-request environment snapshot (variables unset by the caller are removed from the host too); rewrites R2–R6 automatically (`2>/dev/null`, `export`, `curl`, `Join-Path`, `ls -la`/`rm -rf`); R7–R10 only suggest alternatives; every rewrite prints a `[ps51] A → B` annotation.
- A resident PowerShell 5.1 host: named pipe with length-prefixed JSON frames; exits after 10 idle minutes, rebuilds on demand, restarts after a crash or timeout; reuses one runspace, passes output through as raw bytes (`[Console]::Out/Error` is returned separately as raw bytes) and derives the exit code from the script's final `$?`. Scripts containing the `exit` keyword run in a one-shot process so the code stays exact.
- Configuration switches `PS51_GUARD`, `PS51_MODE`, `PS51_STRICT`, `PS51_VERBOSE`, `PS51_DIAGNOSTICS` plus a JSON-lines diagnostics log.
- Tests: rule unit tests, 33 real command corpus cases executed end-to-end through the shim, and a 200-execution host stability and latency run; `docs/measurements.md` records the M0 baseline, latency and exit-code semantics.

### Notes

- This is an unreleased 0.1.0 development version; the version number and release timing are up to the maintainer.
- Known limitations: absolute-path calls and commands inside `cmd /c` cannot be intercepted; `-File` and `-EncodedCommand` pass through untouched.
