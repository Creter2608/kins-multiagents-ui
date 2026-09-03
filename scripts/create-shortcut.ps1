$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Kins Multi-Agents Cockpit.lnk"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$electronExe = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"
$mainJs = "dist\src\main\index.js"

if (-not (Test-Path $electronExe)) {
    Write-Error "electron.exe not found at $electronExe. Run 'npm install' first."
    exit 1
}

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = $electronExe
$sc.Arguments = $mainJs
$sc.WorkingDirectory = $repoRoot
$sc.Description = "Kin's Multi-Agents UI Cockpit"
$sc.Save()

Write-Host "Created shortcut: $shortcutPath" -ForegroundColor Green
