# 打包成 Windows 桌面软件的方案

> 目标：把现在的 `python run.py` + 浏览器访问，变成**双击一个 exe 就打开的原生窗口程序**，
> 装到 `Program Files` 也能正常读写数据，卸载不丢档案。
>
> 本文只做方案与实施设计，**不含代码改动**。所有行号对应评审时的文件版本。

---

## 1. 结论先行

**推荐方案：PyInstaller（onedir）+ pywebview + Inno Setup 安装包。**

| 方案 | 体积 | 观感 | 改造量 | 说明 |
|---|---|---|---|---|
| PyInstaller + 系统浏览器 | ~40MB | 浏览器标签页，有地址栏 | 小 | 最省事，但"不像软件" |
| **PyInstaller + pywebview** | ~~40MB~~ **~45MB** | **原生窗口，无地址栏** | **中** | **推荐** |
| Tauri + Python sidecar | ~15MB | 原生 | 大 | 要 Rust 工具链，本地工具不值当 |
| Electron + Python sidecar | ~180MB | 原生 | 大 | 体积是 pywebview 的 4 倍 |
| Nuitka 编译 | ~40MB | 同 PyInstaller | 中 | 启动快一点、反编译难，但编译慢坑多，收益不成正比 |

pywebview 在 Windows 上用的是系统自带的 **Edge WebView2 运行时**
（Win11 内置；Win10 近几年的版本基本也都带了；极老版本会自动引导安装），
所以它本身只有几百 KB，几乎不增加体积。

---

## 2. 现状：四处打包后会直接出问题的耦合

打包不是"加个 PyInstaller 命令"就行。当前代码有四处假设了"程序跑在仓库目录里"，
打包后全部失效：

| # | 位置 | 现状 | 打包后的后果 |
|---|---|---|---|
| 1 | `app/config.py:5` | `BASE_DIR = Path(__file__).resolve().parent.parent` | 冻结后指向 `%TEMP%\_MEIxxxx\`，每次启动都是新目录 |
| 2 | `app/config.py:8` | `DATA_DIR = BASE_DIR / "data"` | **数据库跟着临时目录走，每次启动档案全空**；装到 Program Files 还会因无写权限直接崩 |
| 3 | `app/config.py:12` | `STATIC_DIR = BASE_DIR / "app" / "static"` | 静态资源其实**能**随包打进去，但路径不能靠 `__file__` 推 |
| 4 | `app/config.py:16` | `DEFAULT_PORT = 8300` 写死 | 端口被占就起不来；多开也会抢端口 |

第 2 条是致命的——**它会让用户的档案静默消失**。这也是本文最需要重视的一点。

顺带确认：`app/main.py:144` 的截图目录 `MEDIA_DIR = DATA_DIR / "screenshots"` 挂在 `DATA_DIR` 下，
所以只要 `DATA_DIR` 改对，截图会跟着一起走到用户目录，不用单独处理。

---

## 3. 架构改造

```text
开发模式（当前）                    桌面模式（目标）
┌──────────────┐                  ┌────────────────────────┐
│  代码仓库     │                  │ Tracelight\            │  ← onedir 目录
│  app/ + data/│                  │  ├─ Tracelight.exe
│  混放         │                  │  ├─ _internal\（依赖+static，只读）
└──────┬───────┘                  │  └─ portable.txt（可选，便携模式开关）
       │                          └───────────┬────────────┘
       ▼                                      │
  uvicorn :8300                               ▼
  （固定端口）                      %LOCALAPPDATA%\Tracelight\
       │                            ├─ projects.db      ← 档案
       ▼                            ├─ backups\         ← 自动备份
  系统浏览器                         ├─ screenshots\     ← 截图
                                    └─ app.log          ← 日志
                                              │
                                              ▼
                                     uvicorn :随机空闲端口
                                              │
                                              ▼
                                     pywebview 原生窗口
```

### 3.1 路径改造（必须做）

核心原则：**只读资源和可写数据彻底分离**。

```python
# app/config.py
import os, sys
from pathlib import Path

APP_TITLE = "Tracelight"

def _is_frozen() -> bool:
    """PyInstaller 冻结后 sys.frozen 为 True，代码实际在 sys._MEIPASS 临时/内部目录。"""
    return getattr(sys, "frozen", False)

def _resource_dir() -> Path:
    """只读资源（app/static 等）：冻结后指向包内目录，开发时指向仓库根。"""
    if _is_frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent

def _data_dir() -> Path:
    """可写数据（db / backups / screenshots / log）：永远在用户目录。"""
    if _is_frozen():
        exe_dir = Path(sys.executable).parent
        # 便携模式：exe 旁放一个 portable.txt，数据就存 exe 同目录（U 盘场景）
        if (exe_dir / "portable.txt").exists():
            return exe_dir / "data"
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_TITLE

BASE_DIR  = _resource_dir()   # 只读
STATIC_DIR = BASE_DIR / "app" / "static"
DATA_DIR  = _data_dir()       # 可写
DB_PATH   = DATA_DIR / "projects.db"
```

**首次运行的数据迁移**：老用户仓库里已有 `data/projects.db`，
应在启动时检测"用户目录无 db 但 exe 同目录/旧位置有 db"，自动复制过去并提示一次。
否则升级用户会以为档案丢了。

### 3.2 动态端口（必须做）

```python
def pick_port(host: str = HOST, preferred: int = 8300, tries: int = 50) -> int:
    """从 preferred 起找第一个能绑定的端口；全被占用则交给系统分配一个。"""
    import socket
    for p in range(preferred, preferred + tries):
        with socket.socket() as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    with socket.socket() as s:          # 端口 0 = 让系统挑
        s.bind((host, 0))
        return s.getsockname()[1]
```

用 pywebview 时端口对用户不可见，随机分配完全没问题，还能彻底避开冲突。

### 3.3 桌面入口 `desktop.py`（新增）

后台线程跑 uvicorn，主线程开原生窗口：

```python
"""桌面模式入口：后台线程跑 uvicorn，主线程开 pywebview 原生窗口。"""
import socket, sys, threading, time, traceback, logging

def _wait_port(port, timeout=15.0):
    """轮询到服务真正在监听再开窗口，避免白屏。"""
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False

def main():
    from app.config import HOST, DATA_DIR, pick_port
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=DATA_DIR / "app.log", level=logging.INFO,
                        encoding="utf-8", format="%(asctime)s %(levelname)s %(message)s")

    port = pick_port()
    import uvicorn
    from app.main import app

    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    if not _wait_port(port):
        logging.error("服务未能在 15 秒内启动")
        return 1

    try:
        import webview
    except ImportError:                      # 没装 pywebview 就退回浏览器
        import webbrowser
        webbrowser.open(f"http://{HOST}:{port}")
        try:
            while not server.should_exit:
                time.sleep(0.5)
        except KeyboardInterrupt:
            server.should_exit = True
        return 0

    win = webview.create_window("归迹拾光", f"http://{HOST}:{port}",
                                width=1440, height=900, min_size=(1024, 700))
    win.events.closed += lambda: setattr(server, "should_exit", True)  # 关窗即退出
    webview.start()
    return 0
```

**关窗必须让服务退出**，否则进程会残留成僵尸（这是桌面化的第一个坑）。

### 3.4 异常兜底（必须做）

`--noconsole` 后没有控制台，`print` 和未捕获异常都会**静默消失**，用户只看到"双击没反应"。

```python
def _excepthook(etype, value, tb):
    msg = "".join(traceback.format_exception(etype, value, tb))
    logging.error("未捕获异常：\n%s", msg)
    if getattr(sys, "frozen", False) and os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg[-1800:], "归迹拾光 - 出错了", 0x10)
sys.excepthook = _excepthook
```

### 3.5 单实例（建议做）

双击两次会起两个进程、抢同一数据文件。三种做法，推荐第二种：

1. 固定"锁端口"探测——简单但会白占一个端口；
2. **锁文件**：在 `DATA_DIR` 写 `.lock`，启动时读到已有且进程存活则激活旧窗口退出；
3. Windows 命名互斥体（`ctypes` 调 `CreateMutexW`）——最干净，但要写平台分支。

### 3.6 系统托盘（可选）

pywebview 本身不带托盘，要配合 `pystray` + `Pillow`（+约 8MB）。
做"关闭窗口最小化到托盘、托盘菜单退出"，体验更接近原生软件，但属于加分项。

---

## 4. 打包配置

### 4.1 依赖

```
# requirements-desktop.txt（在现有基础上追加）
pyinstaller>=6.10
pywebview>=5.1
```

### 4.2 PyInstaller spec（`build.spec`）

```python
# -*- mode: python -*-
from PyInstaller.utils.hooks import collect_submodules

# uvicorn 大量子模块是运行时动态导入的，必须显式声明，否则打包后起不来
hiddenimports = [
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    "uvicorn.supervisors.watchfilesreload",
    "git", "gitdb", "smmap", "markdown", "webview",
]

a = Analysis(
    ["desktop.py"],
    pathex=[],
    binaries=[],
    datas=[("app/static", "app/static")],     # 前端资源随包
    hiddenimports=hiddenimports,
    hookspath=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Tracelight",
    icon="assets/app.ico",
    console=False,                            # 不弹黑框
    version="version_info.txt",               # 可选：文件属性里的版本号
)
coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False, upx=False,                   # upx 容易触发杀软，建议关
    name="Tracelight",
)
```

构建：

```bash
pyinstaller build.spec --noconfirm --clean
# 产物在 dist/Tracelight/
```

### 4.3 onefile 还是 onedir

| | onefile（单 exe） | onedir（目录） |
|---|---|---|
| 交付 | 一个文件，方便传 | 一个文件夹 |
| **启动速度** | **每次启动都要解压 40MB 到临时目录，3–8 秒** | **直接启动，<1 秒** |
| 杀软误报 | 更高 | 较低 |

**推荐 onedir + Inno Setup 做成安装程序**：用户拿到的是单个 `Setup.exe`，
装完在开始菜单有快捷方式，但运行时是 onedir，启动飞快。鱼和熊掌兼得。

---

## 5. 风险与坑

### 5.1 杀毒软件误报（现实问题，要有心理准备）

PyInstaller 打出来的 exe 是"自解压 + 内存加载"结构，特徴和行为相近，**主流杀软（尤其 Windows Defender）经常误报**。

应对：
- 关闭 UPX 压缩（上面 spec 已关）；
- **代码签名**能基本解决，但 OV 证书每年几百到几千元；
- 免费替代：在 VirusTotal 提交白名单申诉、让用户加信任；
- 自用/内部分发的话，加 Defender 排除项即可：
  `Add-MpPreference -ExclusionPath "D:\...\Tracelight"`

### 5.2 GitPython 依赖系统 git

`gitinfo.py` 已经把异常兜住了（ImportError / InvalidGitRepository / 通用 Exception 都有降级），
所以**目标机器没装 git 不会崩**，但 Git 面板会显示"读取失败"。

建议补一个友好提示：启动时检测 `shutil.which("git")`，没有就在首页挂一条提示条
"未检测到 git，Git 信息/提交记录不可用（不影响其他功能）"，而不是让用户看到一堆红色报错。

> 不要为了消除这个依赖去捆绑便携版 Git for Windows（+30MB 且要处理许可证声明），不划算。

### 5.3 `--noconsole` 后 print 全部失效

`run.py:32` 那句 `print(f"归迹拾光服务已启动：{url}")` 在桌面模式下没人看得见。
所有输出必须改走 `logging` 写文件，见 §3.4。

### 5.4 首次启动白屏

后端启动和窗口创建有竞态。`desktop.py` 里的 `_wait_port()` 轮询是必须的，不能只 `sleep(1.2)`。

### 5.5 数据迁移

老用户升级到 exe 版时，档案还在仓库的 `data/projects.db`。不做迁移会**看起来像档案丢了**。
见 §3.1 末尾。

### 5.6 图标缓存

换 ico 后 Windows 资源管理器可能仍显示旧图标（图标缓存未刷新）。
测试时用绝对新路径，或重启 explorer / `ie4uinit.exe -show`。

---

## 6. 实施路线图

```text
第 1 步 · 半天 · 解耦（不引入任何打包依赖，纯重构）
  config.py：_is_frozen / _resource_dir / _data_dir / pick_port
  desktop.py：uvicorn 后台线程 + _wait_port + 关窗退出 + 日志 + excepthook
  验收：python desktop.py 能弹出窗口，数据仍写到仓库 data/（开发模式行为不变）

第 2 步 · 半天 · 打通打包
  加 requirements-desktop.txt、build.spec、assets/app.ico
  跑通 pyinstaller，解决 uvicorn 隐式导入
  验收：dist 目录下双击 exe 能开窗口；数据落到 %LOCALAPPDATA%
        杀掉进程再开，档案还在

第 3 步 · 半天 · 体验补齐
  单实例检测、首次运行数据迁移、git 缺失提示、
  便携模式（portable.txt）
  验收：双击两次只开一个窗口；老 data/ 能自动迁移；无 git 环境不报错

第 4 步 · 半天 · 交付形态
  Inno Setup 写安装脚本（开始菜单快捷方式 + 卸载程序 + 版本号）
  出 Setup.exe，在干净虚拟机里装一遍
  验收：全新 Win10/11 虚拟机安装 → 启动 → 录入项目 → 卸载 → 重装 → 档案仍在

第 5 步 · 可选 · 锦上添花
  系统托盘（pystray）、打包进 CI（GitHub Actions）、自动更新检查
```

**关键提示**：第 1 步做完不要急着做第 2 步，先在**干净虚拟机**里验证一遍再往下走。
打包的坑几乎都集中在"开发机能跑、别人机器上跑不了"，早验证省很多时间。

---

## 7. 验收清单

- [ ] 全新 Windows 虚拟机（无 Python、无 Node）双击即可运行
- [ ] 装到 `C:\Program Files\` 下能正常读写数据（验证 UAC 权限）
- [ ] 关闭窗口后进程完全退出（任务管理器里无残留）
- [ ] 重启程序，档案、笔记、截图全部还在
- [ ] 双击第二次不会起第二个实例
- [ ] 从旧版（仓库 `data/projects.db`）升级后档案能自动迁移
- [ ] 未安装 git 的机器上不崩溃，且给出明确提示
- [ ] 程序异常时有日志文件可查（`%LOCALAPPDATA%\...\app.log`）
- [ ] 卸载后用户数据保留（或明确提示会删除，二者选一且写进卸载向导）
- [ ] 控制面板「程序和功能」里能看到名称、版本、发布者
