Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('D:\python\karfarma\Iran-stock\Iran-Stock-Screener-Latest.zip')
$z.Entries | Sort-Object Name | Select-Object Name, @{n='Size';e={$_.Length}} | Format-Table -AutoSize
$z.Dispose()
