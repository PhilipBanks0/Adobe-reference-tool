@echo off
rem Checks GitHub for a newer Reference Tool and installs it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %* & echo. & pause
