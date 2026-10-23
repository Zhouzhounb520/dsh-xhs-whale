@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\启动小红书服务.ps1" %*
set "startupExit=%errorlevel%"
if not "%startupExit%"=="0" pause
exit /b %startupExit%
