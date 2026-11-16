# dsh-ps51-guard

> Status: scaffolding (0.1.0). The plugin body is not implemented yet; the development roadmap (`ROADMAP.md`) stays in the maintainer's local workspace (git-ignored) and is not distributed with the repository.

Transfer protection, compatibility rewrites and result normalization for **Windows PowerShell 5.1** invocations made through `ops_bash`, so quoting, encoding and syntax differences stop turning into failed calls and retries.

## What it solves

| Area | Today | Goal |
| --- | --- | --- |
| Command transfer | bash expansion can consume quotes and `$` before PowerShell sees them | Transfer the command with a UTF-16LE `-EncodedCommand` |
| Syntax compatibility | PowerShell 7 syntax fails outright on 5.1 | Rewrite by verified rules; high-risk forms only get an alternative |
| Execution feedback | Errors hide behind a zero exit code or mojibake | Normalize exit status and output encoding, leaving decoding to the existing output plugins |

## Current state

The repository currently ships peripheral components only: package manifest, bundle patch, central CI wiring, bilingual docs and the roadmap. `lib/index.js` is a placeholder entry that keeps the Cordis `apply` contract so the manifest, packaging and CI checks can run for real.

## Planned capabilities

- **Ownership by executable**: take over only commands that resolve to PowerShell 5.1; `pwsh`, a `powershell` function installed by another plugin, and unknown paths all pass through untouched.
- **Resident host**: a PowerShell 5.1 cold start costs about 200–800ms, so the first delivery includes a resident host to cut call latency, falling back to a one-shot process when the host is unavailable.
- **Rules and hints**: R1–R10 cover known differences such as `2>/dev/null`, `export`, `curl`, `Join-Path` and `ls -la`; `&&`, `||` and `??` only suggest an alternative, never rewrite.

## Configuration (reserved)

| Variable | Default | Effect |
| --- | --- | --- |
| `PS51_GUARD` | `1` | Set to `0` to disable the guard entirely and restore the original call |
| `PS51_MODE` | `rewrite` | Set to `annotate` to report rewrites without applying them |

These variables only take effect once M1/M3 land; reading them in the current version changes nothing.

## Development

```bash
npm test
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
```

## Roadmap

Milestones, acceptance criteria and risks live in the maintainer's local `ROADMAP.md` (not committed, not published). M0 technical baselines are mostly done; the plugin body starts at M1.

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
