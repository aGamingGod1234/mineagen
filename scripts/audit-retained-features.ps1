[CmdletBinding()]
param([string] $ProjectRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }

$Project = [IO.Path]::GetFullPath($ProjectRoot)

# These paths are the explicit retention boundary for cleanup work. Keep this
# audit independent from deletion candidates so it remains useful after a cut.
$retainedFiles = [ordered]@{
    'control center screen' = 'src/client/java/dev/agaminggod/mineagen/client/gui/AgentControlScreen.java'
    'voice runtime' = 'src/main/java/dev/agaminggod/mineagen/server/voice/VoiceSubsystemRuntime.java'
    'shared server pathfinder' = 'src/main/java/dev/agaminggod/mineagen/server/runtime/controller/ServerPathPlanner.java'
    'visual identity' = 'src/main/java/dev/agaminggod/mineagen/agent/AgentVisualIdentity.java'
    'visual manifest' = 'src/main/resources/assets/mineagen/identity/agent_visual_manifest.json'
    'presentation verification' = 'src/test/java/dev/agaminggod/mineagen/client/control/AgentClientPresentationVerification.java'
    'voice verification' = 'src/test/java/dev/agaminggod/mineagen/server/voice/VoiceSubsystemVerification.java'
    'shared navigation verification' = 'src/test/java/dev/agaminggod/mineagen/server/runtime/controller/ServerPathPlannerVerification.java'
}

$missing = [Collections.Generic.List[string]]::new()
foreach ($entry in $retainedFiles.GetEnumerator()) {
    $path = Join-Path $Project $entry.Value
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $missing.Add("$($entry.Key): $($entry.Value)")
    } else {
        Write-Host "RETAINED $($entry.Key): $($entry.Value)"
    }
}

$verificationCalls = @(
    'AgentClientPresentationVerification.verify()',
    'VoiceSubsystemVerification.verify()',
    'ServerPathPlannerVerification.verify()'
)
$verificationMainPath = Join-Path $Project 'src/test/java/dev/agaminggod/mineagen/verification/VerificationMain.java'
if (-not (Test-Path -LiteralPath $verificationMainPath -PathType Leaf)) {
    $missing.Add('core verification entrypoint: src/test/java/dev/agaminggod/mineagen/verification/VerificationMain.java')
} else {
    $verificationMain = Get-Content -LiteralPath $verificationMainPath -Raw
    foreach ($check in $verificationCalls) {
        if ($verificationMain.IndexOf($check, [StringComparison]::Ordinal) -lt 0) {
            $missing.Add("core verification wiring: $check")
        } else {
            Write-Host "WIRED $check"
        }
    }
}

if ($missing.Count -gt 0) {
    throw "Retained-feature audit failed:`n - $($missing -join "`n - ")"
}

Write-Host ("Retained-feature audit passed: {0} files and {1} core verification calls." -f $retainedFiles.Count, $verificationCalls.Count)
