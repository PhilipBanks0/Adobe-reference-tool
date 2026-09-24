@echo off
rem Removes the Reference Tool add-on. (Kept on one line because this file deletes itself.)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %* & echo. & pause
