@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ローカル動画圧縮ツール

where node >nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo インストール方法（PowerShell / コマンドプロンプト）:
  echo   winget install OpenJS.NodeJS.LTS
  echo または https://nodejs.org/ からインストールしてください。
  pause
  exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [エラー] FFmpeg が見つかりません。
  echo インストール方法（PowerShell / コマンドプロンプト）:
  echo   winget install Gyan.FFmpeg
  echo インストール後、PCまたはウィンドウを開き直して再実行してください。
  pause
  exit /b 1
)

node server.js --open
pause
