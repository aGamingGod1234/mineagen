[CmdletBinding()]
param(
	[string] $ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Windows PowerShell redraws Invoke-WebRequest's progress bar for every chunk, which made the 80 MB download take over a
# minute on CI.
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') {
	throw 'The bundled Node.js acquisition step currently supports Windows only.'
}

$nodeVersion = '22.23.2'
$nodeSha256 = '0d0f5e39' + 'f9f3d958' + '7bc19f73' + 'eab3c2c9' +
		'c4903fd0' + '2d6dbf9c' + '853dd81b' + '3d95fad4'
$downloadUri = "https://nodejs.org/dist/v$nodeVersion/win-x64/node.exe"
$project = [IO.Path]::GetFullPath($ProjectRoot)
$runtime = Join-Path $project 'runtime\toolchains\node'
$node = Join-Path $runtime 'node.exe'

function Test-PinnedNodeRuntime([string] $NodePath) {
	if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
	if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nodeSha256) { return $false }
	$versionText = (& $NodePath --version 2>&1 | Out-String).Trim()
	return $LASTEXITCODE -eq 0 -and $versionText -ceq "v$nodeVersion"
}

# Windows can hold a sharing lock on node.exe for seconds after the process that ran it exits (CI saw it outlast a
# 2 s window), so a move retries for up to 20 s and logs each retry before it gives up with the last error.
function Move-ItemWithRetry([string] $LiteralPath, [string] $Destination) {
	$deadline = [DateTime]::UtcNow.AddSeconds(20)
	$attempt = 0
	while ($true) {
		try {
			Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
			if ($attempt -gt 0) { Write-Host "Moved $LiteralPath after $attempt retries" }
			return
		} catch {
			$lockLike = $_.Exception -is [System.IO.IOException] -or $_.Exception -is [System.UnauthorizedAccessException]
			$attempt++
			if (-not $lockLike -or [DateTime]::UtcNow -ge $deadline) { throw }
			Write-Host "Move of $LiteralPath to $Destination failed (retry $attempt): $($_.Exception.Message)"
			Start-Sleep -Milliseconds 500
		}
	}
}

if (Test-PinnedNodeRuntime $node) {
	Write-Host "Bundled Node.js v$nodeVersion is ready: $node"
	return
}

$transactionId = [Guid]::NewGuid().ToString('N')
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "mineagen-node-$transactionId"
$downloadedNode = Join-Path $temporaryRoot 'node.exe'
$staging = "$runtime.staging-$transactionId"
$backup = "$runtime.backup-$transactionId"

try {
	New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
	Invoke-WebRequest -UseBasicParsing -Uri $downloadUri -OutFile $downloadedNode
	$downloadedHash = (Get-FileHash -LiteralPath $downloadedNode -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($downloadedHash -cne $nodeSha256) {
		throw "Downloaded Node.js v$nodeVersion hash mismatch. Expected $nodeSha256, got $downloadedHash."
	}
	$downloadedVersion = (& $downloadedNode --version 2>&1 | Out-String).Trim()
	if ($LASTEXITCODE -ne 0 -or $downloadedVersion -cne "v$nodeVersion") {
		throw "Downloaded Node.js version check failed. Expected v$nodeVersion, got '$downloadedVersion'."
	}

	New-Item -ItemType Directory -Path (Split-Path -Parent $runtime) -Force | Out-Null
	New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
	Move-ItemWithRetry $downloadedNode (Join-Path $staging 'node.exe')
	$backedUp = $false
	$promoted = $false
	try {
		if (Test-Path -LiteralPath $runtime) {
			Move-ItemWithRetry $runtime $backup
			$backedUp = $true
		}
		Move-ItemWithRetry $staging $runtime
		$promoted = $true
		if (-not (Test-PinnedNodeRuntime $node)) {
			throw "Bundled Node.js v$nodeVersion failed verification after installation."
		}
	} catch {
		$failure = $_
		try {
			# A failed backup move must never delete the original active runtime.
			if ($promoted -and (Test-Path -LiteralPath $runtime)) { Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction Stop }
			if ($backedUp -and (Test-Path -LiteralPath $backup)) {
				Move-ItemWithRetry $backup $runtime
			}
		} catch {
			throw "Bundled Node.js installation failed and rollback was incomplete: $($_.Exception.Message). Original failure: $($failure.Exception.Message)"
		}
		throw $failure
	}

	if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
	Write-Host "Installed verified bundled Node.js v${nodeVersion}: $node"
} finally {
	if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
	if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
