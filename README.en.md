# dsh-ps51-guard

> Status: 0.1.0, milestones M1–M3 implemented. Transfer protection, syntax rewrites and result normalization for **Windows PowerShell 5.1** invocations made through `ops_bash`.

DSH's `ops_bash` runs commands in bash, while `powershell`/`powershell.exe` on Windows is 5.1. A command travelling from the model to PowerShell passes through bash quoting and expansion, and 5.1 lacks the syntax and encoding options of PowerShell 7. The result is eaten quotes, `$env:TEMP` becoming `:TEMP`, `2>/dev/null` failing, and errors exiting with code 0. This plugin takes over calls that finally resolve to 5.1 inside the bash process and corrects them before PowerShell sees them.

## How it works

1. In the DSH process the plugin points `BASH_ENV` at its own `bash-env.sh` and chains any previous `BASH_ENV`, so other plugins keep working.
2. The shim reads the original `$BASH_COMMAND` from bash's `DEBUG` trap (before expansion) and only takes over when the command word finally is 5.1; it also exports the list of bash variable names so `$name` ownership can be decided.
3. `lib/client.js` parses the original text, restores values bash expanded from argv, applies the rewrite rules, and hands the command to the resident host.
4. The resident PowerShell 5.1 host (named pipe, 4-byte little-endian length prefix + JSON frames) runs the command and returns stdout/stderr as **raw bytes** (including `[Console]::Out/Error`), exposes stdin through `[Console]::In`, and derives the exit code from the script's final `$?` like `-Command`. If the host is unavailable while connecting, the original call is used instead; a host failure after the request was sent exits with code 125 and never replays the command, so nothing runs twice.

## Ownership

- Only `powershell` / `powershell.exe` that resolve to `%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe` and pass the major-version-5 check (cached for 24 hours) are taken over.
- `pwsh` passes straight through; a command word already defined as a function by another plugin (for example the dsh-pwsh7-bash shim) is never overridden.
- Absolute-path calls (`/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ...`) and calls inside `cmd /c` cannot be intercepted; this is a documented limitation from the roadmap.

## Rules

| Rule | Trigger | Behaviour |
| --- | --- | --- |
| R1 | `$name` inside a `-Command` double-quoted payload | bash variables expand with bash; PowerShell variables (`$env:TEMP` etc.) stay literal |
| R2 | `2>/dev/null` | Rewritten to `2>$null` |
| R3 | `export FOO=bar` | Rewritten to `$env:FOO = 'bar'` |
| R4 | `curl ` | Rewritten to `curl.exe ` (avoiding the PowerShell alias) |
| R5 | `Join-Path a b c` | Rewritten to nested `Join-Path (Join-Path a b) c` |
| R6 | `ls -la`, `rm -rf` | Rewritten to `Get-ChildItem -Force`, `Remove-Item -Recurse -Force` |
| R7 | `-Encoding utf8NoBOM` | Hint only (the 5.1 parameter set rejects that value) |
| R8 | `> file` inside PowerShell | Hint only (5.1 writes UTF-16LE with a BOM; use the .NET API for BOM-less output) |
| R9 | `&&`, `||` | Hint only: `a; if ($?) { b }` |
| R10 | `??`, `?:` | Hint only: the equivalent `if/else` form |

Whenever a rewrite happens, `[ps51] A → B` is printed to stderr so the model knows the command changed. High-risk rules (R7–R10) and the R8 hint are printed only when relevant.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PS51_GUARD` | `1` | Set to `0` to disable the guard entirely and restore the original call |
| `PS51_MODE` | `rewrite` | `annotate` reports without rewriting; `off` passes everything through |
| `PS51_STRICT` | `0` | Set to `1` to block hint-only commands (R7–R10) with exit code 2 |
| `PS51_VERBOSE` | `0` | Set to `1` to print every hint, including low-priority notes such as R8 |
| `PS51_DIAGNOSTICS` | `1` | Set to `0` to stop writing the diagnostics log |

Diagnostics go to `%TEMP%\dsh-ps51-guard-<user>\session-<pid>\diagnostics.log` (JSON lines with the matched rules and the command before/after rewriting); turn them off after debugging. Setting `PS51_TRACE=1` makes the host also write `host-trace.log`.

## Known limitations

- Only `-Command` / `-c` payloads are handled; `-File` and `-EncodedCommand` pass through untouched.
- Scripts containing the `exit` keyword run in a one-shot process (about 0.3–0.5 s) because a runspace cannot report `exit` codes.
- Every command starts one `node` client; with the warmed host this averages about 100 ms per command in one bash session, still above a bare hot 5.1 run.
- When a bash variable and a PowerShell variable with the same name appear together, the argv-expanded value is used and the result is marked `mixed-variables`; that may differ from the model's intent.
- If the host crashes or disconnects after the request was sent, the client exits with code 125 without replaying the command; only a connection failure before the request falls back to the original call.
- stdin is exposed only to `[Console]::In`; native child processes started by the host still get a closed stdin.
- `[Console]::Out/Error` text is forwarded byte for byte but its order relative to PowerShell pipeline output is approximate (console text comes before the formatted pipeline output).
- The exit code is the final `$?` of the script; suppressing errors with `-ErrorAction SilentlyContinue` can therefore still yield 0.

## Development

```bash
npm test
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
```

Tests cover the rewrite rules, 33 real command corpus cases executed end-to-end through the shim, and a 200-execution host stability/latency run. Baselines and measurements live in [docs/measurements.md](./docs/measurements.md).

## Other DSH projects I work on

- [dsh-better-choice](https://github.com/TLEWA/dsh-better-choice) — option notes and side questions for choice cards
- [dsh-fastload](https://github.com/TLEWA/dsh-fastload) — trim the first history page of long sessions
- [dsh-if](https://github.com/TLEWA/dsh-if) — the `/if` conditional command
- [dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router) — keep OpenCode Go routing ids warm and rotate them
- [dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer) — drag-and-drop organizer for seven layout regions
- [dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu) — sidebar context menus and open-with actions
- [dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output) — fix GBK/CP936 mojibake from Windows subprocesses
- [dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs) — normalize no-argument tool calls in PTC `run_code`

## License

MIT, see [LICENSE](./LICENSE).
