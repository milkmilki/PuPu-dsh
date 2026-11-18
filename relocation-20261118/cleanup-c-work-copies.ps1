$ErrorActionPreference = 'Stop'
$pupuRoot = 'D:\ProjectICreate\PuPuBot\pupu_20260425_105129'
$pupuOperation = Join-Path $pupuRoot 'operations\relocation-20261118'

function Assert-ExactDirectory([string]$Path, [string]$Expected) {
    $pupuResolved = (Get-Item -LiteralPath $Path -Force).FullName.TrimEnd('\')
    $pupuExpected = [System.IO.Path]::GetFullPath($Expected).TrimEnd('\')
    if (![string]::Equals($pupuResolved, $pupuExpected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected deletion target: $pupuResolved"
    }
    $pupuDirectory = Get-Item -LiteralPath $Path -Force
    if (!$pupuDirectory.PSIsContainer -or ($pupuDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Recursive cleanup requires a plain directory: $Path"
    }
}

if (!(Test-Path -LiteralPath (Join-Path $pupuOperation 'cleanup-approved.json'))) {
    throw 'Review cleanup-precheck.json and write cleanup-approved.json before deleting C work copies.'
}
$pupuApproval = Get-Content -LiteralPath (Join-Path $pupuOperation 'cleanup-approved.json') -Raw | ConvertFrom-Json
if ($pupuApproval.approved -ne $true) { throw 'Cleanup has not passed file verification.' }
$pupuCheck = Get-FileHash -LiteralPath (Join-Path $pupuOperation 'cleanup-precheck.json') -Algorithm SHA256
if ($pupuCheck.Hash -ne $pupuApproval.precheckSha256) { throw 'Cleanup precheck changed after review.' }

$pupuNewPackage = 'file:D:/ProjectICreate/PuPuBot/pupu_20260425_105129/dsh-qq-notes/artifacts/dsh-qq-0.1.6.tgz'
foreach ($pupuLock in @(
    'C:\Users\57859\.dsh\profiles\web\package.json',
    'C:\Users\57859\.dsh\profiles\web\pnpm-lock.yaml',
    'C:\Users\57859\.dsh\profiles\web\node_modules\.pnpm\lock.yaml'
)) {
    $pupuText = Get-Content -LiteralPath $pupuLock -Raw
    if (!$pupuText.Contains($pupuNewPackage) -or $pupuText.Contains('file:C:/Users/57859/Projects/dsh-qq-notes/')) {
        throw "Formal profile has not switched fully to D: $pupuLock"
    }
}

$pupuTargets = @(
    @{ Source = 'C:\Users\57859\Projects\dsh-qq-notes'; Destination = (Join-Path $pupuRoot 'dsh-qq-notes') },
    @{ Source = 'C:\Users\57859\.codex\tmp\dsh-qq-build-20261118'; Destination = (Join-Path $pupuRoot '.build\dsh-qq-build-20261118') },
    @{ Source = 'C:\Users\57859\.dsh\backups\pupu-notes-activation-2026-11-18T01-31-10-926Z'; Destination = (Join-Path $pupuRoot 'operations\pupu-notes-activation-2026-11-18T01-31-10-926Z') },
    @{ Source = 'C:\Users\57859\AppData\Local\Temp\pupu-dialogue-count-20BsLb'; Destination = (Join-Path $pupuRoot 'operations\disk-audit-dialogue-copy') }
)

foreach ($pupuTarget in $pupuTargets) {
    Assert-ExactDirectory $pupuTarget.Source $pupuTarget.Source
    if (!(Test-Path -LiteralPath $pupuTarget.Destination -PathType Container)) {
        throw "Verified D destination is missing: $($pupuTarget.Destination)"
    }
}

$pupuJunctionPath = 'C:\Users\57859\Projects\dsh-qq-notes\node_modules'
if (Test-Path -LiteralPath $pupuJunctionPath) {
    $pupuJunction = Get-Item -LiteralPath $pupuJunctionPath -Force
    if (!($pupuJunction.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Expected the old source dependency entry to be a junction.'
    }
    if (@($pupuJunction.Target).Count -ne 1 -or $pupuJunction.Target -ne 'C:\Users\57859\.codex\tmp\dsh-qq-build-20261118\runtime\node_modules') {
        throw 'Old dependency junction points somewhere unexpected.'
    }
    # Delete only the junction entry, without recursing into its target.
    [System.IO.Directory]::Delete($pupuJunctionPath)
}

$pupuDeleted = @()
foreach ($pupuTarget in $pupuTargets) {
    Assert-ExactDirectory $pupuTarget.Source $pupuTarget.Source
    Remove-Item -LiteralPath $pupuTarget.Source -Recurse -Force
    if (Test-Path -LiteralPath $pupuTarget.Source) { throw 'Cleanup did not remove the intended source.' }
    $pupuDeleted += $pupuTarget.Source
}

$pupuOldWorkspaceParent = 'C:\Users\57859\Projects\pupu-qq-workspaces'
if (Test-Path -LiteralPath $pupuOldWorkspaceParent) {
    Assert-ExactDirectory $pupuOldWorkspaceParent 'C:\Users\57859\Projects\pupu-qq-workspaces'
    if (@(Get-ChildItem -LiteralPath $pupuOldWorkspaceParent -Force).Count -ne 0) {
        throw 'The old QQ workspace parent has unexpected content; preserve it.'
    }
    Remove-Item -LiteralPath $pupuOldWorkspaceParent -Force
    $pupuDeleted += $pupuOldWorkspaceParent
}

@{
    completedAt = (Get-Date).ToString('o')
    deletedWorkCopies = $pupuDeleted
    formalDshHomePreserved = 'C:\Users\57859\.dsh'
    verifiedBackupRoot = (Join-Path $pupuOperation 'offline-backup')
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $pupuOperation 'cleanup-result.json')
Write-Output 'Removed verified C-drive work copies; formal DSH data and migration backups remain.'
