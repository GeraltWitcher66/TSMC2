param(
    [string]$Src = 'C:\Users\Artin\Downloads\needed\drive\python\Iran stock\iran-stock-screener-latest-20260909-222704',
    [string]$Dst = 'D:\python\karfarma\Iran-stock\Iran-Stock-Screener-Latest.zip',
    [string]$Stage = 'D:\python\karfarma\Iran-stock\_stg',
    [string]$Verify = 'D:\python\karfarma\Iran-stock\_verify'
)
$root = Split-Path $Src -Leaf
$excludeDirs = @(
    '.freebuff',
    'work',
    '.backup-20260923',
    'node_modules',
    'dist',
    '.wrangler',
    'tsconfig.tsbuildinfo'
)
$excludeFiles = @(
    'zip_build.py',
    'zip_build.ps1',
    'next-env.d.ts'
)
if (Test-Path $Stage) {
    Remove-Item -Path $Stage -Recurse -Force
}
if (Test-Path $Verify) {
    Remove-Item -Path $Verify -Recurse -Force
}
if (-not (Test-Path $Stage)) {
    $null = New-Item -Path $Stage -ItemType Directory -Force
}
function Stage-One($src, $dst) {
    $items = Get-ChildItem -LiteralPath $src -Force | Sort-Object Name
    foreach ($it in $items) {
        $name = $it.Name
        if ($excludeDirs -contains $name) { continue }
        if ($excludeFiles -contains $name) { continue }
        if ($name -like '*.env*') { continue }
        $srcp = $it.FullName
        $dstp = Join-Path $dst $name
        if ($it.PSIsContainer) {
            $null = New-Item -Path $dstp -ItemType Directory -Force
            Stage-One $srcp $dstp
        } else {
            Copy-Item -LiteralPath $srcp -Destination $dstp -Force
        }
    }
}
Stage-One $Src $Stage
if (Test-Path $Dst) { Remove-Item -Path $Dst -Force }
Compress-Archive -Path "$Stage\*" -DestinationPath $Dst -Force
Remove-Item -Path $Stage -Recurse -Force
$info = Get-Item $Dst
Write-Host "Dst=$($info.FullName)"
Write-Host "Size=$($info.Length)"
Expand-Archive -Path $Dst -DestinationPath $Verify -Force
$verifyCount = 0
Get-ChildItem -LiteralPath $Verify -Recurse -Force | ForEach-Object {
    $global:verifyCount++
}
Write-Host "VerifyCount=$global:verifyCount"
Remove-Item -Path $Verify -Recurse -Force
