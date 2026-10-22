"""详情页验收夹具：复用首页隔离样例，再补 README/启动项/笔记/变更日志。

只在 isolated_instance 的临时目录内操作；不读取或修改正式档案库。
"""
import json
import sys
from pathlib import Path

from isolated_instance import req
import test_home_final_prepare as home


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main():
    state_path = Path(sys.argv[1])
    home.main()

    state = json.loads(state_path.read_text(encoding="utf-8"))
    root = Path(state["root"]).resolve()
    base = state["base"]
    assert root.name.startswith("tl-fixes-"), root
    listing = req(base, "GET", "/api/projects")[1]["projects"]
    by_name = {p["name"]: p for p in listing}

    tracelight = by_name["Tracelight"]
    path = Path(tracelight["path"])
    write(path / "run.py", "print('tracelight run')\n")
    write(path / "README.md", """# Tracelight

本地项目归档与快速启动。

把散落在磁盘各处的开发项目收进统一索引，数据保存在本机。
支持快速启动、Git 记录与开发笔记。

## 最近进展

- 首页改版完成
- 详情页概览与四分区
""")

    first = req(base, "POST", f"/api/projects/{tracelight['id']}/launchers", {
        "name": "浏览器模式", "command": ".venv\\Scripts\\python.exe run.py",
        "cwd": "", "mode": "console",
    })[1]
    second = req(base, "POST", f"/api/projects/{tracelight['id']}/launchers", {
        "name": "桌面模式", "command": ".venv\\Scripts\\python.exe run.py --desktop",
        "cwd": "", "mode": "console",
    })[1]
    req(base, "PUT", f"/api/projects/{tracelight['id']}/launch-prefs", {
        "order": [f"l:{first['id']}", f"l:{second['id']}"],
        "primary": f"l:{second['id']}",
        "hidden": [],
    })
    req(base, "PUT", f"/api/projects/{tracelight['id']}/launch-note", {
        "note": "1. 先启动虚拟环境\n2. 再运行 `python run.py`\n3. 打开 http://127.0.0.1:8300",
    })

    notes = [
        "# 首页改版下一步\n\n状态与常用标签同时显示。\n\n每日节奏与项目颜色保持对应。\n\n完成后检查排序与拖动。",
        "## 详情页结构\n\n概览先回答「这是什么、做到哪、怎么继续」。\n\n草稿在分区切换时不能丢。",
        "## 验收记录\n\n使用隔离实例，不写真实档案库。",
    ]
    for content in notes:
        status, _ = req(base, "POST", f"/api/projects/{tracelight['id']}/notes",
                        {"content": content})
        assert status == 201

    status, _ = req(base, "POST", f"/api/projects/{tracelight['id']}/changelogs", {
        "title": "v0.2 详情页概览", "content": "重组项目头部与四个内容分区。",
        "entry_date": "",
    })
    assert status == 201

    # 空窗口样例：真实 Git 仓库，但 7 天内没有本人提交（唯一提交在 10 天前）
    quiet = root / "final-samples" / "quiet-repo"
    quiet.mkdir(parents=True, exist_ok=True)
    home.write(quiet / "README.md", "# QuietRepo\n\n一个 7 天内没有新提交的真实仓库。\n")
    home.git(quiet, "init", "-b", "main")
    home.git(quiet, "config", "user.name", "Yibo")
    home.git(quiet, "config", "user.email", "me@example.com")
    home.commit(quiet, "chore: 十天前的旧提交", "me@example.com", home.when(10, 9, 0))
    status, quiet_project = req(base, "POST", "/api/projects", {
        "path": str(quiet), "name": "QuietRepo", "category": "实验",
        "status": "暂停", "tags": ["Python"],
    })
    assert status == 201, quiet_project
    req(base, "PUT", f"/api/projects/{quiet_project['id']}",
        {"description": "用于验证近 7 天无提交的空状态。"})

    print(f"[prepare-detail] Tracelight id={tracelight['id']} "
          f"launchers={first['id']},{second['id']} notes={len(notes)} "
          f"quietId={quiet_project['id']}")


if __name__ == "__main__":
    main()
