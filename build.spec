# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（onedir 模式）。

产出 dist/LocalProjectArchive/，双击其中的 exe 即打开原生窗口。
构建：  pyinstaller build.spec --noconfirm --clean

采用 onedir 而非 onefile：onefile 每次启动都要把几十 MB 解压到临时目录，
启动要等 3–8 秒；onedir 直接启动（<1 秒）。最终分发时用 Inno Setup
把整个目录压成单个安装程序，两者优点兼得。
"""

# uvicorn 大量子模块是运行时按字符串动态导入的，静态分析扫不到，
# 不显式声明的话打包后启动即报 "No module named 'uvicorn.loops.auto'"。
hiddenimports = [
    # ---- uvicorn ----
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.supervisors.watchfilesreload",
    # ---- GitPython ----
    "git",
    "gitdb",
    "smmap",
    # ---- Markdown 渲染 ----
    "markdown",
    # ---- pywebview 与 Windows 后端（pythonnet / clr）----
    "webview",
    "clr",
    # ---- 系统托盘 ----
    "pystray",
    "pystray._win32",
    "PIL",
]

# 随包分发的只读资源（运行期通过 sys._MEIPASS 访问）
datas = [
    ("app/static", "app/static"),
    ("assets", "assets"),
]

a = Analysis(
    ["desktop.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 用不到的 GUI/工具库，减小体积
        "tkinter",
        "PyQt5",
        "PySide2",
        "PySide6",
        "IPython",
        "notebook",
        "pytest",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="LocalProjectArchive",
    icon="assets/app.ico",
    console=False,          # 不弹控制台黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,               # UPX 压缩会显著提高杀软误报率，关掉
    name="LocalProjectArchive",
)
