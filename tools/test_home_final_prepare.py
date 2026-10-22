"""F6 首页验收样例：在 isolated_instance 中构造接近参考图的数据。

只操作测试台临时目录：删除默认两条样例档案、创建 10 个项目、5 个真实 Git 仓库、
最近 7 天本人提交、状态/标签/置顶与不同访问时间，并写入测试设置。
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from isolated_instance import req


def git(cwd, *args, **env):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True,
                   encoding="utf-8",
                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                        "GIT_CONFIG_NOSYSTEM": "1", **env},
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def commit(repo, message, email, when):
    stamp = when.astimezone().isoformat()
    git(repo, "commit", "--allow-empty", "-m", message,
        GIT_AUTHOR_NAME="Yibo" if email == "me@example.com" else "Teammate",
        GIT_AUTHOR_EMAIL=email,
        GIT_COMMITTER_NAME="Yibo" if email == "me@example.com" else "Teammate",
        GIT_COMMITTER_EMAIL=email,
        GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)


def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def when(days_ago: int, hour: int, minute: int = 0):
    day = (datetime.now().astimezone() - timedelta(days=days_ago)).date()
    return datetime(day.year, day.month, day.day, hour, minute).astimezone()


PROJECTS = [
    {
        "name": "Tracelight", "folder": "tracelight", "alias": "归迹",
        "status": "进行中", "category": "桌面应用",
        "tags": ["Python", "FastAPI", "Vue"],
        "intro": "本地项目归档与快速启动",
        "git": True,
        "commits": [(0, 10, 10, "feat: 首页布局与侧栏导航"),
                    (0, 16, 30, "fix: 修正最近打开排序"),
                    (1, 15, 0, "docs: 补充验收说明"),
                    (3, 11, 0, "refactor: 拆分贡献聚合")],
        "other": [(0, 18, 0, "chore: 依赖升级")],
    },
    {
        "name": "WindowAnchor", "folder": "window-anchor",
        "status": "进行中", "category": "桌面应用",
        "tags": ["C#", ".NET"], "intro": "保存窗口位置，找回工作现场",
        "git": True, "pinned": True,
        "commits": [(0, 9, 20, "feat: 恢复多显示器窗口"),
                    (2, 10, 0, "fix: 处理隐藏窗口"),
                    (2, 16, 40, "test: 补充窗口恢复用例")],
        "other": [],
    },
    {
        "name": "SkillManager", "folder": "skill-manager",
        "status": "进行中", "category": "桌面应用",
        "tags": ["Rust", "Tauri", "Vue"], "intro": "统一管理我的 AI 技能",
        "git": True, "pinned": True,
        "commits": [(1, 14, 0, "feat: 技能市场筛选"),
                    (4, 16, 0, "fix: 安装路径校验")],
        "other": [(1, 17, 0, "docs: 更新 readme")],
    },
    {
        "name": "SuKe", "folder": "suke",
        "status": "进行中", "category": "桌面工具",
        "tags": ["C#", ".NET"], "intro": "应用与窗口布局恢复工具",
        "git": False, "commits": [], "other": [],
    },
    {
        "name": "NextPaste", "folder": "next-paste",
        "status": "进行中", "category": "桌面应用",
        "tags": ["Go", "Wails", "Vue"], "intro": "剪贴板历史与快捷粘贴",
        "git": True,
        "commits": [(0, 8, 40, "feat: 剪贴板历史分组")],
        "other": [],
    },
    {
        "name": "LinuxDoSearch", "folder": "linuxdo-search",
        "status": "进行中", "category": "工具",
        "tags": ["Python", "SQLite"], "intro": "社区话题的本地搜索",
        "git": True,
        "commits": [(0, 12, 10, "feat: 本地索引增量更新")],
        "other": [],
    },
    {
        "name": "PaperTrail", "folder": "paper-trail",
        "status": "暂停", "category": "研究工具",
        "tags": ["Vue", "TypeScript"], "intro": "论文复现与实验记录",
        "git": False, "commits": [], "other": [],
    },
    {
        "name": "ArchiveBox", "folder": "archive-box",
        "status": "已完成", "category": "学习实验",
        "tags": ["Python"], "intro": "告一段落的实验归档",
        "git": False, "commits": [], "other": [],
    },
    {
        "name": "OldVault", "folder": "old-vault",
        "status": "归档", "category": "资料库",
        "tags": ["Vue"], "intro": "旧项目资料留档",
        "git": False, "commits": [], "other": [],
    },
    {
        "name": "Scratch", "folder": "scratch",
        "status": "废弃", "category": "实验",
        "tags": ["C"], "intro": "不再维护的临时草稿",
        "git": False, "commits": [], "other": [],
    },
]


def main():
    state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    root = Path(state["root"]).resolve()
    base = state["base"]
    assert root.name.startswith("tl-fixes-"), root
    health = req(base, "GET", "/api/health")[1]
    assert Path(health["data_path"]).resolve() == root / "data" / "projects.db"

    # 清掉测试台默认两条样例档案（只删隔离库记录，不动样例目录）
    for item in req(base, "GET", "/api/projects")[1]["projects"]:
        req(base, "DELETE", f"/api/projects/{item['id']}")

    samples = root / "final-samples"
    created = []
    for spec in PROJECTS:
        path = samples / spec["folder"]
        path.mkdir(parents=True, exist_ok=True)
        write(path / "README.md",
              f"# {spec['name']}\n\n{spec['intro']}。\n\n用于首页改版验收的隔离样例。\n")
        write(path / "src" / "main.txt", "demo\n")
        if "Python" in spec["tags"]:
            write(path / "pyproject.toml",
                  '[project]\nname = "%s"\nversion = "0.1.0"\n' % spec["folder"])
        if any(t in spec["tags"] for t in ("Vue", "Go", "Tauri", "Wails", "TypeScript")):
            write(path / "package.json", json.dumps(
                {"name": spec["folder"], "version": "0.1.0",
                 "scripts": {"dev": "vite"}}, indent=2))
        if spec["git"]:
            git(path, "init", "-b", "main")
            git(path, "config", "user.name", "Yibo")
            git(path, "config", "user.email", "me@example.com")
            # 先放一个基础提交，避免空仓库没有 HEAD
            commit(path, "chore: 初始化仓库", "me@example.com", when(10, 9, 0))
            for days, hour, minute, message in spec["commits"]:
                commit(path, message, "me@example.com", when(days, hour, minute))
            for days, hour, minute, message in spec["other"]:
                commit(path, message, "other@example.com", when(days, hour, minute))

        status, project = req(base, "POST", "/api/projects", {
            "path": str(path), "name": spec["name"], "alias": spec.get("alias", ""),
            "category": spec["category"], "status": spec["status"],
            "tags": spec["tags"],
        })
        assert status == 201, project
        req(base, "PUT", f"/api/projects/{project['id']}",
            {"description": spec["intro"]})
        if spec.get("pinned"):
            req(base, "POST", f"/api/projects/{project['id']}/pin")
        created.append(project["id"])

    req(base, "PUT", "/api/settings", {
        "git.author_emails": ["me@example.com"],
        "ui.nav_tags": ["Python", "Vue", "C#", "Go"],
        "ui.nav_sections": ["quick", "status", "tags"],
        "ui.nav_statuses": ["进行中", "暂停", "已完成", "归档", "废弃"],
    })

    # 访问时间样例：今天 / 昨天 / 3 天前 / 7 天前 / 无记录。
    # 这是对隔离测试库的夹具写入；访问事件本身由 test_home_redesign_api.py 单独验证。
    by_name = {p["name"]: p["id"] for p in
               req(base, "GET", "/api/projects")[1]["projects"]}
    stamps = {
        "Tracelight": datetime.now().astimezone(),
        "WindowAnchor": datetime.now().astimezone() - timedelta(days=1),
        "NextPaste": datetime.now().astimezone() - timedelta(days=3),
        "SkillManager": datetime.now().astimezone() - timedelta(days=7),
    }
    db_path = root / "data" / "projects.db"
    conn = sqlite3.connect(db_path)
    for name, stamp in stamps.items():
        conn.execute("UPDATE projects SET last_opened_at=? WHERE id=?",
                     (stamp.isoformat(), by_name[name]))
    conn.commit()
    conn.close()

    week = req(base, "GET", "/api/weekly")[1]
    assert week["total"] == 11, week
    assert week["project_count"] == 5, week
    assert week["active_days"] == 5, week
    assert week["identity_required"] is False
    print(f"[prepare] 项目 {len(created)} 个；本周拾光 total={week['total']} "
          f"projects={week['project_count']} days={week['active_days']}")


if __name__ == "__main__":
    main()
