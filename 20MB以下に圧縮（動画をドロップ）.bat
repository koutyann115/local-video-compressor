@echo off
chcp 65001 >nul
title 20MB以下に圧縮

if "%~1"=="" (
  echo.
  echo 動画ファイルをこのアイコンの上にドラッグ＆ドロップしてください。
  echo 元の動画と同じフォルダに「元ファイル名_20MB.mp4」を自動で作成します。
  echo （複数ファイル同時ドロップにも対応しています）
  echo.
  pause
  exit /b 0
)

node "%~dp0cli.js" --size 20 --format mp4 %*
if errorlevel 1 (
  echo.
  echo [エラー] 一部またはすべての動画の圧縮に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

echo.
echo 完了しました！元の動画と同じフォルダを確認してください。
pause
