param([switch]$WithCodeGraph)
$ErrorActionPreference = 'Stop'
$pupuLauncher = Join-Path $PSScriptRoot 'pupu-notes-activation-2026-11-18T01-31-10-926Z\start-web.ps1'
if (!(Test-Path -LiteralPath $pupuLauncher -PathType Leaf)) {
    throw 'DSH launcher is missing from the relocated operations folder.'
}
& $pupuLauncher -SkipCodeGraph:(!$WithCodeGraph)
