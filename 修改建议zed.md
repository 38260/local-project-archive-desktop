说明一下：这次对话里我这边没有拿到文件编辑类工具（只有读取/搜索类工具），所以下面直接给出**可以照抄应用的完整改动**，而不是我直接改库。内容分两块：先是这次新发现的 bug（含根因和修复代码），然后是"启动"功能识别逻辑 + UI 体验的整体优化方案（含具体代码）。

## 一、新发现的 Bug

### 🔴 Bug 1（严重）："在新终端窗口运行"模式下，命令会被 Windows 命令行二次转义弄坏

位置：`app/routers/projects.py` `launch_project()`（约 L714-717）

```python
proc = subprocess.Popen(
    ["cmd", "/k", command], cwd=workdir,
    creationflags=subprocess.CREATE_NEW_CONSOLE)
```

**触发条件**：`command` 里本身已经带了一层引号，且整体又包含空格。这恰好是"智能推断"里最常见的两种建议：
- 检测到项目内 venv 时：`launcher.py` 里 `py_cmd = f'"{venv_py}"'`，拼出 `"D:\...\.venv\Scripts\python.exe" run.py`；
- `.ps1` 直接启动项：`powershell -NoProfile -ExecutionPolicy Bypass -File "C:\...\script.ps1"`。

**根因**：Python 在 Windows 上把 `["cmd", "/k", command]` 这种列表转成一行命令时，会调用 `subprocess.list2cmdline()`，它会把 `command` 整体再包一层引号，并把其中已有的引号转义成 `\"`。而 `cmd.exe` 对 `/K` 后面内容有自己独立的"引号数必须恰好是 2 个"的启发式规则（`cmd /?` 里有文档）。经过 `list2cmdline` 二次转义后，引号数变成 4 个，触发 cmd 的"剔除首尾引号、保留中间原文"的兜底逻辑，产生一段以裸 `\"` 开头的乱码命令，实际表现就是新终端窗口里报"不是内部或外部命令"，启动直接失败。

**修复**（把整行命令直接作为字符串传给 `Popen`，跳过 `list2cmdline` 的二次转义）：

```python
proc = subprocess.Popen(  # noqa: S603 本地工具，用户确认后执行
    f"cmd /k {command}", cwd=workdir,
    creationflags=subprocess.CREATE_NEW_CONSOLE)
```

Windows 下 `Popen` 收到字符串（`shell=False`）时会原样作为 `lpCommandLine` 交给 `CreateProcess`，不会再走一次转义，`cmd.exe` 收到的就是原始、干净的 `cmd /k "D:\...\python.exe" run.py`，行为符合预期。

### 🔴 Bug 2："直接运行"模式下自定义启动项的"子目录"字段被静默忽略

位置：同一函数 `launch_project()`，`open` 分支：

```python
if mode == "open":
    if not os.path.isabs(command):
        command = os.path.normpath(os.path.join(path, command))
    if not os.path.isfile(command):
        raise HTTPException(400, ...)
    os.startfile(command)   # ← 完全没用到前面算好的 workdir
```

而编辑弹窗（`project.html` L819-822）里"子目录"字段对任何"运行方式"都是可编辑的，没有任何联动提示。用户如果给一个 `mode=open` 的启动项填了子目录（比如 monorepo 里 `frontend/dist/app.exe`），会发现程序确实启动了，但工作目录不对（`os.startfile` 在 Python 3.13 之前不支持指定 cwd，默认用的是服务进程自己的工作目录），如果目标程序依赖相对路径读配置就会出问题，而且用户完全得不到任何提示。

**修复**：

```python
if mode == "open":
    if not os.path.isabs(command):
        command = os.path.normpath(os.path.join(path, command))
    if not os.path.isfile(command):
        raise HTTPException(
            400, f"直接运行的目标文件不存在：{command}\n「直接运行」需要可执行文件的完整路径。")
    if os.path.normpath(workdir) != os.path.normpath(path):
        # os.startfile 在 3.13 前不支持指定工作目录；用 start /D 走系统 shell，
        # 让目标程序以子目录为当前目录启动（不少程序靠相对路径读取自身配置）
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(f'cmd /c start "" /D "{workdir}" "{command}"',
                          creationflags=flags)
    else:
        os.startfile(command)  # noqa: S606 与资源管理器双击行为一致
    return {"ok": True, "mode": "open", "note": "已直接运行（与资源管理器双击等效）"}
```

---

## 二、"启动"识别逻辑优化（`app/services/launcher.py`）

现状是"漏斗式二选一"：只要根目录里有任意一个 `.bat/.cmd/.exe/.ps1`，就认定为"direct"，**完全放弃**智能推断。问题是：很多仓库根目录里的 `.bat` 其实是 `build.bat`/`test.bat`/`clean.bat` 这类维护脚本，一旦命中就会把明显更靠谱的 `python run.py` / `npm run dev` 挤掉，用户看到的第一条"推荐启动方式"反而是错的。另外，`parser.py` 里其实已经识别了 Docker / Poetry / Pipenv 这些标记（用来打技术栈标签），但 `launcher.py` 完全没有复用，也没有覆盖 monorepo（前后端分仓）这种项目自己数据模型里早就预留了 `cwd` 字段的场景。

给出完整替换版本（`app/services/launcher.py`）：

```python
"""启动入口检测：漏斗式两级扫描（全程只读，绝不执行任何文件）。

① 直接可执行（较权威）：根目录的 .bat/.cmd/.exe/.ps1、dist 一层内的 .exe。
   文件名明显是 build/test/clean 等维护脚本时不采信为"权威"结果，避免挤掉更靠谱的推断；
② 智能推断：Docker compose / Dockerfile → package.json scripts →
   Python 入口（poetry / pipenv / 项目内 venv 优先于裸 python）→ Cargo/Go；
   一层子目录（frontend/backend 等常见 monorepo 命名）复用同一套推断，附带 cwd。

返回的条目只是候选建议；执行由路由层在用户明确点击按钮后进行。
任何子步骤失败都静默降级为空结果，绝不让检测拖垮详情页。
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from app.config import (
    LAUNCH_COMPOSE_FILES, LAUNCH_DIRECT_EXTS, LAUNCH_ENTRY_FILES,
    LAUNCH_MAINTENANCE_HINTS, LAUNCH_MAX_ITEMS, LAUNCH_MONOREPO_DIRS,
)

logger = logging.getLogger(__name__)

_PREFERRED_SCRIPTS = ["dev", "start", "serve", "preview"]
_LOCKFILE_PM = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun")]
_PRIORITY_PREFIXES = ("start", "run", "dev", "启动")


def _entry(name: str, command: str, mode: str, source: str) -> dict:
    return {"name": name, "command": command, "cwd": "", "mode": mode, "source": source}


def _is_maintenance_name(source: str) -> bool:
    """文件名明显是构建/测试/清理类脚本而非启动脚本时返回 True（漏斗误报缓解）。"""
    stem = Path(source).stem.lower()
    return any(stem == h or stem.startswith(f"{h}_") or stem.startswith(f"{h}-")
               or stem.endswith(f"_{h}") or stem.endswith(f"-{h}")
               for h in LAUNCH_MAINTENANCE_HINTS)


def _scan_direct(root: Path) -> list[dict]:
    """① 直接可执行：根目录脚本/程序 + dist 一层内的 exe。"""
    items: list[dict] = []
    try:
        for it in os.scandir(root):
            if not it.is_file():
                continue
            ext = os.path.splitext(it.name)[1].lower()
            if ext not in LAUNCH_DIRECT_EXTS:
                continue
            if ext == ".ps1":
                items.append(_entry(
                    Path(it.name).stem,
                    f'powershell -NoProfile -ExecutionPolicy Bypass -File "{it.path}"',
                    "console", it.name))
            else:
                items.append(_entry(Path(it.name).stem, it.path, "open", it.name))
    except OSError as exc:
        logger.debug("启动入口扫描失败（根目录）%s: %s", root, exc)
        return []

    dist = root / "dist"
    if dist.is_dir():
        try:
            for d in os.scandir(dist):
                if not d.is_dir():
                    continue
                try:
                    for f in os.scandir(d.path):
                        if f.is_file() and f.name.lower().endswith(".exe"):
                            items.append(_entry(
                                Path(f.name).stem, f.path, "open",
                                f"dist/{d.name}/{f.name}"))
                except OSError:
                    continue
        except OSError as exc:
            logger.debug("启动入口扫描失败（dist）%s: %s", dist, exc)

    seen: set[str] = set()
    uniq: list[dict] = []
    for it in items:
        key = it["command"].lower()
        if key not in seen:
            seen.add(key)
            uniq.append(it)
    uniq.sort(key=lambda it: (
        0 if it["source"].lower().startswith(_PRIORITY_PREFIXES) else 1,
        it["source"].lower()))
    return uniq[:LAUNCH_MAX_ITEMS]


def _find_venv_python(root: Path) -> str | None:
    if os.name != "nt":
        return None
    try:
        for it in os.scandir(root):
            if not it.is_dir():
                continue
            exe = Path(it.path) / "Scripts" / "python.exe"
            if exe.is_file():
                return str(exe)
    except OSError as exc:
        logger.debug("虚拟环境探测失败 %s: %s", root, exc)
    return None


def _uses_poetry(root: Path) -> bool:
    pp = root / "pyproject.toml"
    if not pp.is_file():
        return False
    try:
        return "[tool.poetry]" in pp.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return False


def _scan_inferred(root: Path) -> list[dict]:
    """② 智能推断：Docker → node scripts → Python 入口 → cargo/go。"""
    items: list[dict] = []

    # Docker：compose 一条命令拉起完整环境，优先于单文件推断
    compose = next((f for f in LAUNCH_COMPOSE_FILES if (root / f).is_file()), None)
    if compose:
        items.append(_entry("docker compose up", "docker compose up", "console", compose))
    elif (root / "Dockerfile").is_file():
        img = re.sub(r"[^a-z0-9_.-]", "-", root.name.lower()) or "app"
        items.append(_entry(
            "docker run", f"docker build -t {img} . && docker run -it --rm {img}",
            "console", "Dockerfile"))

    # Node：package.json scripts（lockfile 决定包管理器）
    pkg = root / "package.json"
    if pkg.is_file() and len(items) < LAUNCH_MAX_ITEMS:
        try:
            data = json.loads(pkg.read_text(encoding="utf-8-sig", errors="replace"))
            scripts = data.get("scripts") or {}
            pm = next((cmd for marker, cmd in _LOCKFILE_PM
                       if (root / marker).is_file()), "npm")
            names = ([s for s in _PREFERRED_SCRIPTS if s in scripts]
                     + [s for s in scripts if s not in _PREFERRED_SCRIPTS])
            for s in names[:6]:
                items.append(_entry(
                    f"{s}（{pm}）", f"{pm} run {s}", "console",
                    f"package.json · scripts.{s}"))
                if len(items) >= LAUNCH_MAX_ITEMS:
                    break
        except (OSError, ValueError) as exc:
            logger.debug("package.json 解析失败 %s: %s", pkg, exc)

    # Python：入口文件 + 解释器优先级 poetry > pipenv > 项目内 venv > 裸 python
    if len(items) < LAUNCH_MAX_ITEMS:
        if _uses_poetry(root):
            py_prefix = "poetry run python"
        elif (root / "Pipfile").is_file():
            py_prefix = "pipenv run python"
        else:
            venv_py = _find_venv_python(root)
            py_prefix = f'"{venv_py}"' if venv_py else "python"
        for name in LAUNCH_ENTRY_FILES:
            if (root / name).is_file():
                args = f"{name} runserver" if name == "manage.py" else name
                items.append(_entry(
                    f"启动 {name}", f"{py_prefix} {args}", "console", name))
                if len(items) >= LAUNCH_MAX_ITEMS:
                    break

    # Rust / Go
    if len(items) < LAUNCH_MAX_ITEMS:
        if (root / "Cargo.toml").is_file():
            items.append(_entry("cargo run", "cargo run", "console", "Cargo.toml"))
        if (root / "go.mod").is_file():
            items.append(_entry("go run .", "go run .", "console", "go.mod"))

    return items[:LAUNCH_MAX_ITEMS]


def _scan_monorepo(root: Path) -> list[dict]:
    """一层子目录探测：前后端分仓项目，命中常见目录名即复用同一套推断。

    条目带 cwd（相对项目根），执行时后端切到该子目录再跑命令
    （对应数据模型里早就预留、但自动检测此前从未用到的 launchers.cwd 语义）。
    """
    items: list[dict] = []
    try:
        subdirs = {d.name: d.path for d in os.scandir(root) if d.is_dir()}
    except OSError:
        return items
    for name in LAUNCH_MONOREPO_DIRS:
        hit = next((subdirs[k] for k in subdirs if k.lower() == name), None)
        if not hit:
            continue
        sub_items = _scan_inferred(Path(hit))
        for it in sub_items:
            it["cwd"] = os.path.basename(hit)
            it["name"] = f"{it['name']}（{it['cwd']}/）"
        items.extend(sub_items)
        if len(items) >= LAUNCH_MAX_ITEMS:
            break
    return items[:LAUNCH_MAX_ITEMS]


def detect_launchers(path: str) -> dict:
    """漏斗检测入口。返回 {kind, items}：
    kind = direct（可信的直接可执行）
         | direct_weak（只找到疑似构建/测试脚本，不确定是否为启动方式）
         | inferred（构建配置推断，含 monorepo 子目录）
         | none
    """
    root = Path(path)
    if not root.is_dir():
        return {"kind": "none", "items": []}
    try:
        direct = _scan_direct(root)
        strong_direct = [d for d in direct if not _is_maintenance_name(d["source"])]
        if strong_direct:
            return {"kind": "direct", "items": strong_direct}

        inferred = _scan_inferred(root)
        if len(inferred) < LAUNCH_MAX_ITEMS:
            inferred += _scan_monorepo(root)
        if inferred:
            return {"kind": "inferred", "items": inferred[:LAUNCH_MAX_ITEMS]}
        if direct:
            return {"kind": "direct_weak", "items": direct}
        return {"kind": "none", "items": []}
    except Exception as exc:
        logger.warning("启动入口检测异常 %s: %s", path, exc)
        return {"kind": "none", "items": []}
```

`app/config.py` 需要新增的常量（放在现有 `LAUNCH_*` 常量旁边）：

```python
# 快速启动：Docker 编排/镜像文件
LAUNCH_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
# 快速启动：monorepo 常见子目录名（一层子目录探测前后端分离项目）
LAUNCH_MONOREPO_DIRS = ["frontend", "client", "web", "backend", "server", "api"]
# 快速启动：命中这些关键词的可执行文件大概率是构建/测试/清理脚本而非启动脚本
LAUNCH_MAINTENANCE_HINTS = ("build", "test", "clean", "setup", "install", "deploy",
                            "uninstall", "pack", "publish", "lint", "format", "release", "ci")
```

这套改动带来的效果：
- 根目录只有 `test.bat`/`build.bat` 时不会再被当成权威推荐，会自动回退到更靠谱的智能推断；万一智能推断也没有，仍然展示这些脚本，但标成"不确定"，前端可以给出提示文案而不是直接当成"检测到的启动方式"。
- Docker / Poetry / Pipenv 项目终于能给出合理的启动命令，而不是回退成裸 `python xxx.py`（poetry/pipenv 项目下这样跑很可能因为缺依赖直接失败）。
- Monorepo（`frontend/` + `backend/`）第一次能被自动检测覆盖，而不是必须手动加自定义启动项。

---

## 三、"启动"UI 体验优化（`project.html` + `project.js` + `style.css`）

### 1. 顶部动作栏加一个"一键启动"主按钮

现状：`resource管理器`/`VSCode`/`复制路径` 都在页面顶部，但"启动"要滚到页面底部才能点，和这个工具"快速回到旧项目里跑起来"的定位不太匹配。

`project.js`，在 `computed` 里加：

```js
visibleSuggestions() {
  if (!this.launch) return [];
  const saved = new Set((this.launch.launchers || [])
    .map(l => `${l.mode}|${(l.cwd || "").trim()}|${l.command.trim()}`));
  // 已转存为自定义启动项的建议，不再重复展示同一条命令
  return (this.launch.suggestions || [])
    .filter(s => !saved.has(`${s.mode}|${(s.cwd || "").trim()}|${s.command.trim()}`));
},
primaryLaunchEntry() {
  if (!this.launch || !this.launch.supported) return null;
  return (this.launch.launchers && this.launch.launchers[0])
      || (this.visibleSuggestions && this.visibleSuggestions[0])
      || null;
},
```

在 `methods` 里加：

```js
quickLaunch() {
  if (this.primaryLaunchEntry) this.runEntry(this.primaryLaunchEntry);
  else this.scrollTo("sec-launch");   // 没有明确入口时跳到启动面板自行选择
},
```

`runEntry` 加防重复点击（同时把 `launch.suggestions` 换成上面新增的 `visibleSuggestions`，见下文）：

```js
async runEntry(entry) {
  if (this.launchBusyKey) return;              // 正在启动中，忽略连点
  const modeText = entry.mode === "open" ? "直接运行" : "在新终端窗口运行";
  const cmdText = entry.command + (entry.cwd ? `\n子目录：${entry.cwd}` : "");
  if (this.launchConfirm && !await confirmDialog(
    `将${modeText}：\n${cmdText}\n\n命令来自项目内文件，运行前请确认内容。`,
    { title: `启动 · ${entry.name}`, okText: "启动" })) return;
  this.launchBusyKey = entry.id ? `l${entry.id}` : `s${entry.command}`;
  try {
    const body = entry.id
      ? { launcher_id: entry.id }
      : { command: entry.command, mode: entry.mode, cwd: entry.cwd || "" };
    const r = await api(`/api/projects/${this.projectId}/launch`, { method: "POST", body });
    toast(r.note || "已启动", "ok");
  } catch (e) { /* toast 已提示 */ }
  finally { this.launchBusyKey = null; }
},
```

`data()` 里加一行：`launchBusyKey: null,`

`project.html`，顶部动作栏（`action-row`）里新增按钮，放在最前面：

```html
<button class="btn primary" v-if="launch && launch.supported && primaryLaunchEntry"
        @click="quickLaunch" :disabled="!!launchBusyKey" :title="primaryLaunchEntry.command">
  <lpa-icon name="zap" :size="15"></lpa-icon>{{ launchBusyKey ? "启动中…" : "启动" }}
</button>
<button class="btn primary" @click="openIn('explorer')" :disabled="p.is_lost">
  ...
```

### 2. "启动"面板卡片：加 console/open 模式图标、用 `visibleSuggestions`、更新说明文案

把原来两处：

```html
<template v-if="launch && launch.suggestions.length">
```

和

```html
<div class="launch-entry" v-for="(s, i) in launch.suggestions" :key="i">
```

都换成 `visibleSuggestions`。说明文案：

```html
<div class="launch-group-label">
  自动检测
  <span class="section-note">
    来自{{ {direct:"项目内可执行文件", direct_weak:"项目内脚本（未能确认是否为启动方式，建议核对后再点）", inferred:"构建配置推断"}[launch.detect_kind] || "自动检测" }}
    · 点击即运行，可转存为自定义
  </span>
</div>
```

给按钮加模式小图标（自定义启动项和自动检测两处都加）：

```html
<b>{{ l.name }}
  <lpa-icon :name="l.mode === 'open' ? 'external' : 'terminal'" :size="11" class="lb-mode"
            :title="l.mode === 'open' ? '直接运行' : '新终端窗口'"></lpa-icon>
</b>
```

按钮统一加禁用态防连点：

```html
<button type="button" class="launch-btn" :disabled="!!launchBusyKey" @click="runEntry(l)" ...>
```

空态判断也要同步换成 `visibleSuggestions`：

```html
<div class="section-note" style="margin-top:10px"
     v-if="launch && launch.supported && !launch.launchers.length && !visibleSuggestions.length">
```

### 3. CSS 小调整（`style.css`）

```css
.lb-mode { margin-left: 4px; color: var(--muted); vertical-align: -1px; }
.launch-btn:disabled { opacity: .55; cursor: default; }
.launch-entry { gap: 8px; }   /* 原 4px，拉开一点主按钮与编辑/删除的间距，降低误触概率 */
.lb-ops { gap: 6px; }         /* 原 2px */
```

---

## 四、效果小结

| 问题 | 影响 | 现在 |
|---|---|---|
| console 模式命令被二次转义 | 只要检测到项目内 venv 或用 `.ps1` 启动，新终端窗口直接报错，功能等于坏的 | 已给出一行改动修复 |
| open 模式忽略 cwd | monorepo 场景下自定义"直接运行"启动项工作目录不对，且无任何提示 | 用 `start /D` 兜底，两种模式行为一致 |
| direct 漏斗过于绝对 | 根目录随便一个 build/test 脚本就会盖掉更靠谱的推断 | 按文件名过滤 + 三级 kind（direct/direct_weak/inferred）+ 前端文案区分 |
| 不识别 Docker/Poetry/Pipenv/monorepo | 这类项目只能手动加启动项，工具"自动识别"的核心卖点打了折扣 | 补齐检测，且和 `parser.py` 已有的技术栈识别逻辑保持一致 |
| 顶部没有启动入口、无防连点、无模式区分 | 用户要滚到底部才能启动；容易连点重复开进程；分不清是"弹终端"还是"直接跑" | 顶栏加主按钮、按钮禁用防连点、加模式小图标、自动检测和已转存启动项去重 |

以上改动我按文件整理好了，可以直接对着现有代码位置替换。如果你要我进一步把这些代码实际写入项目文件，可以告诉我一声，我用你允许的工具（或者你手动开启文件编辑权限后）帮你落地。
