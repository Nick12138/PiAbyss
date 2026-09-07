@echo off
chcp 65001 >nul
title PiAbyss
cd /d "%~dp0"

rem ============================================================
rem  Startup option: minimize to taskbar after launch
rem  (window is minimized to the taskbar, NOT hidden)
rem  MINIMIZE=1 -> auto-minimize to taskbar (default)
rem  MINIMIZE=0 -> start in a normal window
rem  Command line: --mini force minimize; --nomini force normal
rem ============================================================
set "MINIMIZE=1"

if /i "%~1"=="--mini"   set "MINIMIZE=1"
if /i "%~1"=="--nomini" set "MINIMIZE=0"

rem On first launch, relaunch self in a minimized window
if "%MINIMIZE%"=="1" (
    if /i not "%~1"=="--minimized" (
        start "PiAbyss" /min "%~f0" --minimized
        exit /b 0
    )
)

if "%MINIMIZE%"=="0" echo Launch mode: normal window
if "%MINIMIZE%"=="1" echo Launch mode: minimized to taskbar

echo Starting PiAbyss...
call pnpm dev:fast
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] PiAbyss exited with code %EXIT_CODE%.
    echo Please scroll up to review the error, then fix it and run this script again.
) else (
    echo PiAbyss exited.
)

echo.
echo Window stays open - press any key to close it yourself.
pause >nul
exit /b %EXIT_CODE%
