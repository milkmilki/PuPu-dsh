param([switch]$SkipCodeGraph)
$ErrorActionPreference = 'Stop'
$pupuActivationRoot = 'D:\ProjectICreate\PuPuBot\pupu_20260425_105129\operations\pupu-notes-activation-2026-11-18T01-31-10-926Z'
$pupuCli = 'C:\Users\57859\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$pupuRepository = 'D:\Temp\DeepseekHarness\deepseek-harness'
$pupuOverlay = 'D:\Temp\DeepseekHarness\deepseek-harness\code-review-graph.cordis.yml'
if (Get-NetTCPConnection -State Listen -LocalPort 3090 -ErrorAction SilentlyContinue) {
    throw 'Port 3090 is already occupied; inspect the owner before restarting.'
}
$env:DSH_HOME = 'C:\Users\57859\.dsh'
$env:CRG_REPO_PATH = $pupuRepository
$pupuArguments = @($pupuCli, '--profile', 'web')
if (!$SkipCodeGraph) { $pupuArguments += @('--patch', $pupuOverlay) }
$pupuArguments += @('--no-open', '--port', '3090')
$pupuServer = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList $pupuArguments -WorkingDirectory $pupuRepository `
    -RedirectStandardOutput (Join-Path $pupuActivationRoot 'web.stdout.log') `
    -RedirectStandardError (Join-Path $pupuActivationRoot 'web.stderr.log') `
    -WindowStyle Hidden -PassThru
@{ pid = $pupuServer.Id; port = 3090; profile = 'web'; codeGraph = !$SkipCodeGraph; startedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $pupuActivationRoot 'web-process.json')
Write-Output "Started DSH web profile on port 3090, PID $($pupuServer.Id)."
