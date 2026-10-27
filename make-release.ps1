# Builds a deploy zip of the app: every file git tracks (plus new, not-ignored
# files), so .gitignore'd production data — data.sqlite, .env, sessions/,
# public/uploads/, node_modules/ — is never included or overwritten.
# Extract the zip straight into the server's app folder, replacing existing
# files, then restart the app (run `npm install` first only if package.json changed).
#
# Usage:  powershell -ExecutionPolicy Bypass -File make-release.ps1
# Output: ..\shoppingList-release-YYYYMMDD-HHmm.zip (next to the project folder)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$zipPath = Join-Path (Split-Path $PSScriptRoot -Parent) "shoppingList-release-$stamp.zip"

# *.sqlite is excluded explicitly too: database copies like "data (1).sqlite"
# aren't covered by .gitignore and must never be unpacked over the server.
$files = git ls-files --cached --others --exclude-standard | Where-Object { $_ -and ($_ -notlike '*.sqlite') -and (Test-Path $_ -PathType Leaf) } | Sort-Object -Unique

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zipPath) { Remove-Item $zipPath -Confirm:$false }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($f in $files) {
        # Entry names use forward slashes (Compress-Archive on Windows
        # PowerShell writes backslashes, which Linux `unzip` treats as part of
        # the file name instead of folders).
        $entry = $f -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path $f).Path, $entry) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host "Created $zipPath ($($files.Count) files)"
