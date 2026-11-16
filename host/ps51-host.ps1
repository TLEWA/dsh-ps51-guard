#requires -Version 5.1
<#
Resident PowerShell 5.1 host for dsh-ps51-guard.

One process per machine user, listening on a named pipe. Each connection
carries length prefixed JSON frames (uint32 little-endian length, then UTF-8
JSON), the same framing the Node client uses.

Requests:
  { id, op: "exec", script, cwd?, env? }
  { id, op: "ping" }
Responses:
  { id, type: "out", dataB64 }
  { id, type: "err", dataB64 }
  { id, type: "exit", code, durationMs, parseError? }
  { id, type: "pong" }

The host reuses one runspace so a hot call costs one Invoke instead of a full
powershell.exe start. Scripts that contain the exit keyword never reach the
host: the client routes them to a one-shot spawn, because a runspace cannot
report their exit code.
#>
param(
	[string]$PipeName = 'dsh-ps51-guard',
	[ValidateRange(1000, 86400000)]
	[int]$IdleMs = 600000,
	[switch]$Once
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$MaxFrameBytes = 64MB
$CrLf = [string]([char]13) + [char]10

function Write-Trace([string]$Message) {
	if ($env:PS51_TRACE -ne '1') { return }
	try {
		$path = Join-Path $env:PS51_RUNTIME 'host-trace.log'
		$line = (Get-Date).ToString('HH:mm:ss.fff') + ' [' + $PID + '] ' + $Message
		Add-Content -LiteralPath $path -Value $line -Encoding UTF8
	} catch {
	}
}

$Utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$Baseline = @{}
Get-ChildItem Env: | ForEach-Object { $Baseline[$_.Name] = $_.Value }

function ConvertTo-PsLiteral([string]$Value) {
	if ($null -eq $Value) { return "''" }
	return "'" + $Value.Replace("'", "''") + "'"
}

function Read-Exact([System.IO.Stream]$Stream, [int]$Count) {
	$buffer = New-Object byte[] $Count
	$read = 0
	while ($read -lt $Count) {
		$n = $Stream.Read($buffer, $read, $Count - $read)
		if ($n -le 0) { return $null }
		$read += $n
	}
	return $buffer
}

function Read-Frame([System.IO.Stream]$Stream) {
	$header = Read-Exact $Stream 4
	if ($null -eq $header) { return $null }
	$length = [BitConverter]::ToUInt32($header, 0)
	if ($length -gt $MaxFrameBytes) { throw 'frame too large: ' + $length }
	$body = Read-Exact $Stream ([int]$length)
	if ($null -eq $body) { return $null }
	return ([System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json)
}

function Write-Frame([System.IO.Stream]$Stream, $Payload) {
	$json = $Payload | ConvertTo-Json -Compress -Depth 8
	$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
	$header = [BitConverter]::GetBytes([uint32]$bytes.Length)
	$Stream.Write($header, 0, 4)
	$Stream.Write($bytes, 0, $bytes.Length)
	$Stream.Flush()
}

function ConvertTo-Base64([string]$Text) {
	return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Restore-BaselineEnv {
	$current = @{}
	Get-ChildItem Env: | ForEach-Object { $current[$_.Name] = $_.Value }
	foreach ($name in @($current.Keys)) {
		if (-not $Baseline.ContainsKey($name)) {
			[Environment]::SetEnvironmentVariable($name, $null)
		}
	}
	foreach ($name in @($Baseline.Keys)) {
		$now = [Environment]::GetEnvironmentVariable($name)
		if ($now -ne $Baseline[$name]) {
			[Environment]::SetEnvironmentVariable($name, $Baseline[$name])
		}
	}
}

$Runner = [powershell]::Create()

# Every request starts from a clean session state: variables, functions and
# preference changes made by one command must not leak into the next one.
function Reset-Runner {
	try {
		$Runner.Runspace.ResetRunspaceState()
	} catch {
		try { $Runner.Dispose() } catch { }
		$script:Runner = [powershell]::Create()
	}
}

function Invoke-Payload([string]$Script, [string]$Cwd) {
	Reset-Runner
	$Runner.Commands.Clear()
	[void]$Runner.Streams.ClearStreams()
	$prelude = ''
	if ($Cwd) {
		$prelude = 'Set-Location -LiteralPath ' + (ConvertTo-PsLiteral $Cwd) + '; '
	}
	[void]$Runner.AddScript($prelude + $Script)

	# [Console]::Out/Error bypass the PowerShell streams, so redirect them
	# while the script runs and forward the captured text in the outcome.
	$capturedOut = New-Object System.IO.StringWriter
	$capturedErr = New-Object System.IO.StringWriter
	$savedOut = [Console]::Out
	$savedErr = [Console]::Error
	[Console]::SetOut($capturedOut)
	[Console]::SetError($capturedErr)

	$result = $null
	$parseError = $null
	try {
		$result = $Runner.Invoke()
	} catch {
		$message = $_.Exception.Message
		$inner = $_.Exception.InnerException
		if ($null -ne $inner) { $message = $inner.Message }
		$parseError = $message
	} finally {
		try {
			[Console]::SetOut($savedOut)
			[Console]::SetError($savedErr)
		} catch {
		}
	}

	$outLines = @()
	if ($null -ne $result -and $result.Count -gt 0) {
		$outLines = @($result | Out-String -Stream -Width 200)
	}
	foreach ($info in $Runner.Streams.Information) {
		$data = $info.MessageData
		if ($data -is [System.Management.Automation.HostInformationMessage]) {
			$outLines += $data.Message
		} else {
			$outLines += [string]$data
		}
	}
	foreach ($line in ($capturedOut.ToString() -split "\r?\n")) {
		if ($line -ne '') { $outLines += $line }
	}

	$errLines = @()
	foreach ($record in $Runner.Streams.Error) {
		# ToString keeps the message only; Out-String would echo the prelude line.
		$errLines += ([string]$record).TrimEnd()
	}
	foreach ($line in ($capturedErr.ToString() -split "\r?\n")) {
		if ($line -ne '') { $errLines += $line }
	}
	if ($parseError) { $errLines += $parseError }

	$code = 0
	if ($parseError) { $code = 1 }
	elseif ($Runner.HadErrors) { $code = 1 }

	return @{
		out = $outLines
		err = $errLines
		code = $code
		parseError = $parseError
	}
}

function Send-Text([System.IO.Stream]$Stream, [string]$Id, [string]$Type, [string[]]$Lines) {
	if ($null -eq $Lines -or $Lines.Count -eq 0) { return }
	$text = [string]::Join($CrLf, $Lines) + $CrLf
	Write-Frame $Stream @{ id = $Id; type = $Type; dataB64 = (ConvertTo-Base64 $text) }
}

function Serve-Connection([System.IO.Stream]$Stream) {
	while ($true) {
		$request = $null
		try {
			$request = Read-Frame $Stream
		} catch {
			try { Write-Frame $Stream @{ id = 'unknown'; type = 'err'; dataB64 = (ConvertTo-Base64 ('[ps51] ' + $_.Exception.Message + $CrLf)) } } catch { }
			return
		}
		if ($null -eq $request) { return }
		$id = [string]$request.id

		if ($request.op -eq 'ping') {
			Write-Frame $Stream @{ id = $id; type = 'pong'; pid = $PID }
			continue
		}
		if ($request.op -ne 'exec') {
			Write-Frame $Stream @{ id = $id; type = 'exit'; code = 2; durationMs = 0; parseError = ('unsupported op: ' + [string]$request.op) }
			continue
		}

		$started = [DateTime]::UtcNow
		$envDiff = $request.env
		if ($null -ne $envDiff) {
			foreach ($property in $envDiff.PSObject.Properties) {
				if ($null -eq $property.Value) {
					[Environment]::SetEnvironmentVariable($property.Name, $null)
				} else {
					[Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value)
				}
			}
		}

		try {
			$outcome = Invoke-Payload ([string]$request.script) ([string]$request.cwd)
		} finally {
			Restore-BaselineEnv
		}
		$duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds

		if ($env:PS51_TRACE -eq '1') {
			Write-Trace ('exec script=[' + [string]$request.script + '] code=' + $outcome.code)
			foreach ($line in $outcome.err) { Write-Trace ('err: ' + $line) }
		}
		Send-Text $Stream $id 'out' $outcome.out
		Send-Text $Stream $id 'err' $outcome.err
		$exit = @{ id = $id; type = 'exit'; code = $outcome.code; durationMs = $duration }
		if ($outcome.parseError) { $exit.parseError = $outcome.parseError }
		Write-Frame $Stream $exit
	}
}

Write-Trace ('host start pipe=' + $PipeName)
$pipeOptions = [System.IO.Pipes.PipeOptions]::Asynchronous

$createFailures = 0
while ($true) {
	$server = $null
	try {
		$server = New-Object System.IO.Pipes.NamedPipeServerStream(
			$PipeName,
			[System.IO.Pipes.PipeDirection]::InOut,
			1,
			[System.IO.Pipes.PipeTransmissionMode]::Byte,
			$pipeOptions
		)
		$createFailures = 0
		Write-Trace 'listening'
	} catch {
		# A previous instance can still be tearing down; retry briefly instead
		# of dying, but give up if the name stays unusable.
		$createFailures += 1
		Write-Trace ('create failed: ' + $_.Exception.Message)
		if ($createFailures -gt 100) { exit 1 }
		Start-Sleep -Milliseconds 100
		continue
	}
	try {
		$wait = $server.BeginWaitForConnection($null, $null)
		if (-not $wait.AsyncWaitHandle.WaitOne($IdleMs)) {
			Write-Trace 'idle timeout'
			break
		}
		Write-Trace 'connection accepted'
		$server.EndWaitForConnection($wait)
		Serve-Connection $server
	} catch {
		# A broken client must not take the host down.
		Write-Trace ('session error: ' + $_.Exception.Message)
	} finally {
		try { $server.Dispose() } catch { }
		Write-Trace 'server disposed'
	}
	if ($Once) { break }
}

try { $Runner.Dispose() } catch { }
exit 0
