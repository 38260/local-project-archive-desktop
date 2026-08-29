@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 一键启动：首次运行自动创建虚拟环境并安装依赖

if not exist .venv\Scripts\python.exe (
    echo [首次运行] 正在创建虚拟环境，请稍候...
    python -m venv .venv
    if errorlevel 1 goto :err
    echo [首次运行] 正在安装依赖（fastapi / uvicorn / GitPython / markdown）...
    .venv\Scripts\python.exe -m pip install -r requirements.txt
    if errorlevel 1 goto :err
)

echo 正在启动本地项目档案服务，浏览器将自动打开 http://127.0.0.1:8300 ...
echo 关闭本窗口或按 Ctrl+C 即可停止服务。
.venv\Scripts\python.exe run.py %*
goto :eof

:err
echo.
echo 启动失败：请确认已安装 Python 3.10+ 并加入 PATH 后重试。
pause
