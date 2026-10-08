$ErrorActionPreference = 'Stop'
$root = 'D:\xkx\projects\trae-auto-checkin'
$vsix = Join-Path $root 'trae-auto-checkin-1.0.4.vsix'
if (Test-Path $vsix) { Remove-Item $vsix -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)

function Add-ZipEntry {
  param($zip, $srcFile, $entryName)
  $e = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
  $s = $e.Open()
  $b = [System.IO.File]::ReadAllBytes($srcFile)
  $s.Write($b, 0, $b.Length)
  $s.Close()
}

foreach ($f in @('package.json', 'extension.js', 'trae-api.js', 'README.md', 'LICENSE', 'icon.png')) {
  Add-ZipEntry $zip (Join-Path $root $f) ('extension/' + $f)
}
foreach ($f in @('extension.vsixmanifest', '[Content_Types].xml')) {
  Add-ZipEntry $zip (Join-Path $root $f) $f
}
$zip.Dispose()
Write-Output ("created: " + $vsix)
