@echo off
rem ---------------------------------------------------------------------------
rem One-shot release build: PyInstaller (onedir) -> Inno Setup (single Setup exe)
rem Output: dist\Tracelight\ (folder build) and dist\installer\Tracelight-Setup-x.y.z.exe
rem NOTE: keep this file ASCII-only; cmd.exe parses .bat in the system codepage.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

echo ===== [1/2] PyInstaller =====
.venv\Scripts\python.exe -m PyInstaller build.spec --noconfirm --clean
if errorlevel 1 (
    echo PyInstaller build FAILED
    exit /b 1
)

echo ===== [2/2] Inno Setup =====
set ISCC=
where iscc >nul 2>&1 && set ISCC=iscc
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set ISCC="%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set ISCC="C:\Program Files\Inno Setup 6\ISCC.exe"
if not defined ISCC (
    echo Inno Setup 6 not found. Install once with:
    echo   winget install --id JRSoftware.InnoSetup -e
    exit /b 2
)
%ISCC% installer\tracelight.iss
if errorlevel 1 (
    echo Inno Setup compile FAILED
    exit /b 1
)

echo.
echo ===== DONE =====
echo Folder build: dist\Tracelight\Tracelight.exe
echo Installer:    dist\installer\
endlocal
