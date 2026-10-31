"""README 截图重拍演示台：造 6 个虚构 git 项目、起隔离服务、种入界面数据，跑截图脚本。

用法（仓库根目录执行）：
  ./.venv/Scripts/python.exe tools/tmp_demo_harness.py \
      --run "node tools/tmp_demo_shots.cjs %TL_STATE%"
截图脚本通过 TL_SHOTS 直接把产物写进仓库 docs/screenshots/，临时根目录结束即删。
数据全部虚构（demo-* 项目、demo@tracelight.dev 等假邮箱），不含任何真实信息。
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def git(cwd, *args, author=("阿真", "demo@tracelight.dev"), when=None):
    env = os.environ.copy()
    env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = author[0]
    env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = author[1]
    if when:
        stamp = when.strftime("%Y-%m-%dT%H:%M:%S %z") if when.tzinfo else \
            when.strftime("%Y-%m-%dT%H:%M:%S") + " +0800"
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = stamp
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                   capture_output=True, text=True)


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# 每个项目的提交信息池：conventional 前缀 + 中文描述，循环取用
MSG_POOLS = {
    "feat": ["新增批量导出功能", "支持暗色主题跟随系统", "列表筛选支持多选", "新增快捷键操作",
             "表格支持列宽拖拽", "接入消息中心", "新增操作日志页", "表单支持草稿暂存"],
    "fix": ["修复分页越界问题", "修复空数据渲染异常", "修正时区换算错误", "修复弹窗滚动穿透",
            "修复上传失败无提示", "修正边界条件判断", "修复搜索高亮错位"],
    "style": ["调整卡片间距", "统一按钮尺寸", "优化表格斑马纹", "修正图标对齐", "微调标题字重"],
    "refactor": ["抽离公共请求层", "拆分过大的组件", "统一错误码结构", "精简冗余状态"],
    "docs": ["更新接入文档", "补充部署说明", "修订贡献指南"],
    "perf": ["列表虚拟滚动优化", "减少重复请求", "图片懒加载"],
    "chore": ["升级依赖版本", "调整构建脚本", "清理废弃文件"],
}
TYPE_CYCLE = ["feat", "feat", "fix", "style", "feat", "refactor", "docs", "perf", "fix", "chore"]


def build_repo(root: Path, name: str, spec: dict):
    """按 spec 造一个带提交历史的虚构项目。spec: files, plan[(days_ago, n)], mate_days"""
    d = root / name
    d.mkdir(parents=True)
    git(d, "init", "-b", "main")
    for rel, content in spec["files"].items():
        write(d / rel, content)
    log = d / "CHANGELOG.md"
    write(log, "# 变更记录\n\n")
    counter = {"i": 0}
    now = datetime.now()

    def commit(days_ago: int, hour: int, mate: bool):
        author = ("小合", "mate@tracelight.dev") if mate else ("阿真", "demo@tracelight.dev")
        ctype = TYPE_CYCLE[counter["i"] % len(TYPE_CYCLE)]
        pool = MSG_POOLS[ctype]
        msg = f"{ctype}: {pool[counter['i'] % len(pool)]}"
        counter["i"] += 1
        write(log, log.read_text(encoding="utf-8") + f"- {msg}\n")
        # 顺手改动一个源文件，让每次提交都有真实 diff
        src = d / "src" / "tick.txt"
        write(src, (src.read_text(encoding="utf-8") if src.exists() else "") + f"{msg}\n")
        when = now - timedelta(days=days_ago) + timedelta(days=0)
        when = when.replace(hour=hour % 24, minute=(counter["i"] * 7) % 60, second=13)
        git(d, "add", "-A", author=author, when=when)
        git(d, "commit", "-m", msg, author=author, when=when)

    for days_ago, n in spec["plan"]:
        for k in range(n):
            commit(days_ago, 9 + k * 3, mate=days_ago in spec.get("mate_days", ()))
    return d


def make_demo_projects(root: Path) -> list:
    samples = root / "samples"
    samples.mkdir(exist_ok=True)
    specs = [
        ("demo-vue-admin", {
            "plan": [(i, 1 if i % 3 else 2) for i in range(150, 0, -1)][:60] + [(i, 1) for i in range(6, -1, -1)],
            "mate_days": (120, 88, 40, 15, 4),
            "files": {
                "package.json": json.dumps({
                    "name": "demo-vue-admin", "private": True, "version": "2.3.0",
                    "scripts": {"dev": "vite", "build": "vite build"},
                    "dependencies": {"vue": "^3.4.0", "pinia": "^2.1.0", "element-plus": "^2.5.0",
                                     "axios": "^1.6.0", "echarts": "^5.4.0"},
                    "devDependencies": {"vite": "^5.0.0"},
                }, indent=2, ensure_ascii=False),
                "README.md": ("# Demo Vue Admin\n\n虚构的管理后台演示项目，用于归迹界面截图。\n\n"
                              "## 快速开始\n\n```bash\nnpm install\nnpm run dev\n```\n\n"
                              "### 环境要求\n\n- Node.js 18+\n- pnpm 8\n\n"
                              "### 启动步骤\n\n克隆后先安装依赖，再启动开发服务器。\n\n"
                              "## 功能模块\n\n- 角色与权限管理\n- 数据看板\n- 操作审计\n- 消息中心\n\n"
                              "### 权限设计\n\n按钮级权限由后端下发，前端按指令显隐。\n\n"
                              "### 看板指标\n\n看板聚合登录、订单与告警三类指标。\n\n"
                              "## 目录结构\n\n```\nsrc/\n├── api/\n├── views/\n└── store/\n```\n\n"
                              "## 部署说明\n\n构建产物为纯静态文件，Nginx 直接托管即可。\n\n"
                              "## 常见问题\n\n遇到问题先查看浏览器控制台与服务端日志。\n\n"
                              + "\n\n".join(f"占位说明第 {i + 1} 行，保证 README 有足够的滚动长度。"
                                            for i in range(24)) + "\n"),
                "index.html": "<!doctype html><title>demo-vue-admin</title>",
                "src/main.js": "import { createApp } from 'vue'\ncreateApp({})\n",
                "src/views/Dashboard.vue": "<template><div class='dash'>看板</div></template>\n",
                "vite.config.js": "export default { server: { port: 5173 } }\n",
            },
        }),
        ("demo-fastapi-service", {
            "plan": [(i, 1 if i % 4 else 2) for i in range(120, 0, -2)][:38] + [(i, 1) for i in range(5, -1, -1)],
            "mate_days": (64, 30, 9),
            "files": {
                "requirements.txt": "fastapi==0.109.0\nuvicorn==0.27.0\nsqlalchemy==2.0.25\npydantic==2.6.0\n",
                "pyproject.toml": "[project]\nname = 'demo-fastapi-service'\nversion = '1.8.2'\n",
                "README.md": "# Demo FastAPI Service\n\n虚构的后端服务演示项目。\n\n## 接口\n\n- /healthz\n- /v1/tasks\n",
                "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/healthz')\ndef health():\n    return {'ok': True}\n",
                "app/models.py": "from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase):\n    pass\n",
                "Dockerfile": "FROM python:3.11-slim\nCOPY . /app\n",
            },
        }),
        ("demo-go-cli", {
            "plan": [(i, 1) for i in range(90, 0, -4)][:22] + [(i, 1) for i in range(6, -2, -2)],
            "mate_days": (46, 12),
            "files": {
                "go.mod": "module demo-go-cli\n\ngo 1.21\n",
                "main.go": "package main\n\nimport 'fmt'\n\nfunc main() { fmt.Println('demo') }\n",
                "README.md": "# Demo Go CLI\n\n虚构的命令行工具演示项目。\n",
            },
        }),
        ("demo-rust-sync", {
            "plan": [(i, 1) for i in range(160, 0, -10)][:16],
            "mate_days": (100, 60),
            "files": {
                "Cargo.toml": "[package]\nname = 'demo-rust-sync'\nversion = '0.9.1'\n",
                "src/main.rs": "fn main() { println!('demo'); }\n",
                "README.md": "# Demo Rust Sync\n\n虚构的同步工具演示项目（已归档）。\n",
            },
        }),
        ("demo-python-bot", {
            "plan": [(i, 1 if i % 2 else 2) for i in range(140, 0, -5)][:30],
            "mate_days": (70, 25),
            "files": {
                "requirements.txt": "requests==2.31.0\nrich==13.7.0\n",
                "bot.py": "print('demo bot')\n",
                "README.md": "# Demo Python Bot\n\n虚构的自动化机器人演示项目（已废弃）。\n",
            },
        }),
        ("demo-docs-site", {
            "plan": [(i, 1) for i in range(80, 0, -8)][:10] + [(3, 1)],
            "mate_days": (48,),
            "files": {
                "index.html": "<!doctype html><title>demo docs</title>",
                "guide/getting-started.md": "# 快速上手\n\n虚构文档站演示项目。\n",
                "README.md": "# Demo Docs Site\n\n虚构的文档站演示项目。\n",
            },
        }),
    ]
    return [(build_repo(samples, name, spec), name) for name, spec in specs]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--run", required=True)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    root = Path(tempfile.mkdtemp(prefix="tl-demo-")).resolve()
    server = None
    try:
        shutil.copytree(repo / "app", root / "app",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(repo / "run.py", root / "run.py")
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        log = (root / "server.log").open("wb")
        server = subprocess.Popen(
            [str(repo / ".venv" / "Scripts" / "python.exe"), "-m", "uvicorn",
             "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=root, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        health = None
        for _ in range(200):
            try:
                st, health = req(base, "GET", "/api/health")
            except Exception:
                health = None
            if health and health.get("ok"):
                break
            if server.poll() is not None:
                raise RuntimeError((root / "server.log").read_text(errors="replace"))
            time.sleep(0.1)
        if not health or not health.get("ok"):
            raise RuntimeError("服务启动超时")

        # 个人贡献口径：统一假邮箱
        st, _ = req(base, "PUT", "/api/settings",
                    {"git.author_emails": ["demo@tracelight.dev"]})
        assert st == 200, "写入设置失败"

        created = []
        for d, name in make_demo_projects(root):
            st, p = req(base, "POST", "/api/projects",
                        {"path": str(d), "category": ""})
            assert st in (200, 201), f"录入 {name} 失败 {st}: {p}"
            created.append((p["id"], name))

        meta = {
            "demo-vue-admin": ("进行中", "Web 应用", ["Vue", "Element Plus", "管理后台"],
                               "面向中后台场景的管理系统：角色权限、数据看板与操作审计，前后端分离。"),
            "demo-fastapi-service": ("进行中", "后端服务", ["FastAPI", "SQLAlchemy", "Docker"],
                                     "任务调度与数据聚合服务，提供 REST API，Docker 单机部署。"),
            "demo-go-cli": ("进行中", "命令行工具", ["Go", "CLI"], "跨平台命令行小工具集合。"),
            "demo-rust-sync": ("归档", "桌面工具", ["Rust"], "本地文件增量同步工具，已归档。"),
            "demo-python-bot": ("废弃", "自动化", ["Python", "自动化"], "消息推送机器人，方案已被替代。"),
            "demo-docs-site": ("进行中", "文档", ["文档站"], "项目文档与上手指南。"),
        }
        for pid, name in created:
            status, cat, tags, desc = meta[name]
            st, _ = req(base, "PUT", f"/api/projects/{pid}",
                        {"status": status, "category": cat, "tags": tags, "description": desc})
            assert st == 200, f"更新 {name} 失败"

        # 给主项目补个人记录与运行历史
        p1 = created[0][0]
        req(base, "POST", f"/api/projects/{p1}/notes",
            {"content": "权限树懒加载在 500+ 节点时有明显卡顿，考虑改成虚拟滚动。\n\n已验证：element-plus 树组件 2.5.4 修复了部分场景。"})
        req(base, "POST", f"/api/projects/{p1}/notes",
            {"content": "看板图表首屏数据量控制在 3 个接口以内，超出部分折叠为「查看更多」。"})
        req(base, "POST", f"/api/projects/{p1}/changelogs",
            {"content": "v2.3.0：新增操作审计页，支持按模块与操作人筛选。", "date": "2026-10-18"})
        req(base, "POST", f"/api/projects/{p1}/changelogs",
            {"content": "v2.2.4：修复角色保存后权限树勾选状态丢失。", "date": "2026-10-06"})
        for i, cmd in enumerate(["cmd /c echo demo-run-ok",
                                 "cmd /c echo demo-run-second",
                                 "cmd /c exit /b 3"]):
            req(base, "POST", f"/api/projects/{p1}/launch",
               {"command": cmd, "mode": "console", "capture": True})
        time.sleep(4)  # 等捕获运行落库

        state = {"root": str(root), "base": base, "projects": created}
        (root / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        print(f"[harness] root={root}\n[harness] base={base}", flush=True)

        env = dict(os.environ)
        env["TL_STATE"] = str(root / "state.json")
        env["TL_BASE"] = base
        env["TL_ROOT"] = str(root)
        env["TL_SHOTS"] = str((repo / "docs" / "screenshots").resolve())
        env["NODE_PATH"] = "D:/AICache/npm/_npx/31e32ef8478fbf80/node_modules"
        proc = subprocess.run(args.run, shell=True, cwd=str(repo), env=env)
        print(f"[harness] 命令退出码：{proc.returncode}", flush=True)
        return proc.returncode
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
            print("[harness] 已清理临时目录", flush=True)
        else:
            print(f"[harness] 保留 {root}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
