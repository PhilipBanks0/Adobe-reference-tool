@echo off
rem Double-click to install the Workpaper Reference Tool into Adobe Acrobat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %* & echo. & pause
