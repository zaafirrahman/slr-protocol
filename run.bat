@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title LitReview Studio

rem ---- 1. Cek Python & Git ------------------------------------------------
set "PY="
py -3.12 --version >nul 2>&1 && set "PY=py -3.12"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  echo [!] Python belum terpasang. Pasang Python 3.12 dari halaman panduan, centang "Add Python to PATH".
  pause & exit /b 1
)

rem ---- 2. Ambil pembaruan terbaru (dilewati bila offline) ------------------
where git >nul 2>&1
if %errorlevel%==0 if exist ".git" (
  echo Memeriksa pembaruan...
  git pull --ff-only
  if errorlevel 1 echo [!] Pembaruan gagal, aplikasi tetap dijalankan dengan versi yang ada.
)

rem ---- 3. File .env pribadi (hanya berisi USER_API_KEY, diisi saat daftar) -
if not exist ".env" (
  echo # Diisi otomatis saat daftar. Jangan dibagikan ke siapa pun.>.env
  echo USER_API_KEY=>>.env
)

rem ---- 4. Virtual environment + dependensi --------------------------------
if not exist "venv\Scripts\python.exe" (
  echo Menyiapkan lingkungan Python (pertama kali, butuh beberapa menit)...
  %PY% -m venv venv
  if errorlevel 1 ( echo [!] Gagal membuat venv. & pause & exit /b 1 )
)
venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 ( echo [!] Gagal memasang dependensi. Cek koneksi internet. & pause & exit /b 1 )

rem ---- 5. Jalankan --------------------------------------------------------
echo.
echo Aplikasi berjalan di http://127.0.0.1:5000  (tutup jendela ini untuk berhenti)
start "" /b cmd /c "timeout /t 3 >nul & start http://127.0.0.1:5000"
venv\Scripts\python.exe app.py
pause
