@echo off
title Kins Multi-Agents Cockpit
cd /d "%~dp0"

if not exist "dist\src\main\index.js" (
    echo [Cockpit] Build artifacts missing. Building application...
    call npm run build
)

start "" "node_modules\electron\dist\electron.exe" dist\src\main\index.js
