#!/usr/bin/env bash
# M0 evidence: what bash hands a DEBUG trap for the seven command shapes the
# guard has to recognise. Run with: bash test/probe/trap-probe.sh
#
# Every TRAP_RAW line is the exact text $BASH_COMMAND holds when the trap fires,
# i.e. the command before bash expands the command word or the PowerShell payload.

set -u

trap 'printf "TRAP_RAW %s\n" "$BASH_COMMAND"' DEBUG

# 1. A bare command with flags.
powershell.exe -NoProfile -Command "Write-Output hello"

# 2. A double-quoted payload that mentions a PowerShell variable.
powershell.exe -NoProfile -Command "Get-Item \$env:TEMP"

# 3. A payload followed by a bash redirection.
powershell.exe -NoProfile -Command "Write-Output x" 2>/dev/null

# 4. A leading environment assignment.
FOO=bar powershell.exe -NoProfile -Command "Write-Output 1"

# 5. A bash control operator between two guarded commands.
powershell.exe -NoProfile -Command "Write-Output a" && powershell.exe -NoProfile -Command "Write-Output b"

# 6. A pipeline where the guarded command is the right-hand side.
echo hi | powershell.exe -NoProfile -Command "Write-Output x"

# 7. A single-quoted payload that must stay literal.
powershell.exe -NoProfile -Command 'Write-Output $Y'

trap - DEBUG
