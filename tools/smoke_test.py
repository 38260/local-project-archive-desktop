"""全流程冒烟测试：对运行中的服务做 API 级验证。

用法：
  1. 先启动服务：  .venv/Scripts/python.exe run.py --no-browser
  2. 再运行测试：  .venv/Scripts/python.exe tools/smoke_test.py [--base http://127.0.0.1:8300]

脚本会在系统临时目录创建 3 个示例项目（含 git 仓库），全部验证通过后
删除它创建的档案记录与临时目录，不影响正式数据。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PASS, FAIL = 0, 0
_created_ids = []       # 测试创建的档案 id，结束时清理
_temp_root = None


def check(name: str, cond: bool, detail: str = ""):
    global PASS, FAIL
    tag = "PASS" if cond else "FAIL"
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print(f"[{tag}] {name}" + (f"  -> {detail}" if detail and not cond else ""))


def req(method: str, path: str, body=None, want_status: int = 200):
    """发起请求，返回 (status, json)。"""
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            text = resp.read().decode()
            # 页面请求返回 HTML，接口请求返回 JSON，这里统一容错
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, {"raw": text}
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except json.JSONDecodeError:
            return e.code, {"detail": text}


def make_samples(root: str):
    """创建示例项目。"""
    def write(path, content):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    # 1. Node 项目（带 git 仓库、node_modules 噪音）
    node = os.path.join(root, "demo-node-app")
    write(os.path.join(node, "package.json"), json.dumps({
        "name": "demo-node-app", "version": "1.2.0",
        "scripts": {"dev": "vite", "build": "vite build"},
        "dependencies": {"vue": "^3.4.0"},
        "devDependencies": {"vite": "^5.0.0"},
    }, indent=2))
    write(os.path.join(node, "README.md"), "# Demo Node App\n\n本地测试项目。\n\n```bash\nnpm install\nnpm run dev\n```\n")
    write(os.path.join(node, "src", "index.js"), "console.log('hi');\n")
    write(os.path.join(node, "node_modules", "fake-pkg", "package.json"), '{"name":"fake"}')
    subprocess.run(["git", "init", "-b", "main", node], check=True, capture_output=True)
    subprocess.run(["git", "-C", node, "add", "."], check=True, capture_output=True)
    subprocess.run(["git", "-C", node, "-c", "user.name=tester", "-c",
                    "user.email=test@test.com", "commit", "-m", "init: 初始提交"],
                   check=True, capture_output=True)

    # 2. Python 项目
    py = os.path.join(root, "demo-python-tool")
    write(os.path.join(py, "pyproject.toml"),
          '[project]\nname = "demo-python-tool"\nversion = "0.1.0"\n'
          'dependencies = ["httpx>=0.27", "rich"]\n')
    write(os.path.join(py, "requirements.txt"), "httpx>=0.27\nrich\n# 注释行\n")
    write(os.path.join(py, "main.py"), "print('demo')\n")

    # 3. C++/CMake 项目
    cpp = os.path.join(root, "demo-cpp-engine")
    write(os.path.join(cpp, "CMakeLists.txt"),
          "cmake_minimum_required(VERSION 3.20)\nproject(demo_engine VERSION 0.3.1)\n")
    write(os.path.join(cpp, "main.cpp"), "int main() { return 0; }\n")

    return node, py, cpp


def cleanup():
    """删除测试创建的档案记录与临时目录。"""
    for pid in _created_ids:
        try:
            req("DELETE", f"/api/projects/{pid}")
        except Exception:
            pass
    if _temp_root and os.path.isdir(_temp_root):
        shutil.rmtree(_temp_root, ignore_errors=True)
    print(f"\n已清理 {len(_created_ids)} 条测试档案记录与临时目录。")


def main():
    global BASE, _temp_root
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8300")
    args = ap.parse_args()
    BASE = args.base.rstrip("/")

    try:
        st, data = req("GET", "/api/health")
        check("健康检查 /api/health", st == 200 and data.get("ok") is True)
    except Exception as e:
        print(f"无法连接服务 {BASE}：{e}\n请先启动 run.py 再运行本测试。")
        return 2

    # 准备示例项目
    _temp_root = tempfile.mkdtemp(prefix="lpa-smoke-")
    node, py, cpp = make_samples(_temp_root)
    print(f"示例项目目录：{_temp_root}\n")

    try:
        # ---- 手动录入 ----
        st, p1 = req("POST", "/api/projects", {"path": node, "category": "测试"})
        check("录入 Node 项目（201）", st == 201 and p1["name"] == "demo-node-app")
        _created_ids.append(p1["id"])
        git = p1["auto_meta"]["git"]
        check("识别 git 仓库与 main 分支", git["is_repo"] and git["branch"] == "main")
        check("最近提交信息可读", git["last_commit"] and "init" in git["last_commit"]["message"])
        check("解析 package.json 依赖", any(c["file"] == "package.json" and "vue" in c["dependencies"]
                                            for c in p1["auto_meta"]["configs"]))
        check("自动识别技术栈标签", "Node.js" in p1["tags"] and "Vue" in p1["tags"])
        check("README 已定位", p1["auto_meta"]["readme_file"] == "README.md")

        # ---- 路径校验 ----
        st, err = req("POST", "/api/projects", {"path": os.path.join(_temp_root, "not-exist")})
        check("无效路径返回 400", st == 400 and err.get("detail"))
        st, err = req("POST", "/api/projects", {"path": node})
        check("重复录入返回 409", st == 409)

        # ---- 详情 / README / 目录树 ----
        st, detail = req("GET", f"/api/projects/{p1['id']}")
        check("详情接口", st == 200 and detail["exists_now"] is True)
        st, readme = req("GET", f"/api/projects/{p1['id']}/readme")
        check("README 渲染（含 <h1>）", st == 200 and readme["exists"] and "<h1" in readme["html"])
        st, tree = req("GET", f"/api/projects/{p1['id']}/tree")
        names = {c["name"] for c in tree["children"]}
        check("目录树包含 src", "src" in names)
        check("目录树跳过 node_modules", "node_modules" not in names)

        # ---- 更新 ----
        notes = "## 项目背景\n测试笔记"
        st, up = req("PUT", f"/api/projects/{p1['id']}",
                     {"description": notes, "status": "已完成", "tags": ["手动标签"]})
        check("更新描述/状态/标签", st == 200 and up["status"] == "已完成" and up["tags"] == ["手动标签"])
        st, p2 = req("GET", f"/api/projects/{p1['id']}")
        check("描述已持久化", notes in p2["description"])
        check("详情返回状态选项列表", st == 200 and p2.get("statuses") == ["进行中", "已完成", "暂停", "归档废弃"])

        # ---- 自定义开发笔记 ----
        st, note_a = req("POST", f"/api/projects/{p1['id']}/notes",
                         {"content": "**踩坑**：Vue3 模板不能直接调用 window 函数"})
        check("新建开发笔记（201）", st == 201 and note_a["created_at"]
              and "踩坑" in note_a["content_html"])
        st, nl = req("GET", f"/api/projects/{p1['id']}/notes")
        check("笔记列表返回渲染 HTML", len(nl["notes"]) == 1 and "<p>" in nl["notes"][0]["content_html"])
        st, note_b = req("POST", f"/api/projects/{p1['id']}/notes", {"content": "第二条笔记"})
        st, up = req("PUT", f"/api/projects/{p1['id']}/notes/{note_b['id']}", {"content": "更新后的笔记"})
        check("编辑笔记", st == 200 and up["content"] == "更新后的笔记")
        st, _ = req("DELETE", f"/api/projects/{p1['id']}/notes/{note_b['id']}")
        check("删除笔记", st == 200)
        st, err = req("PUT", f"/api/projects/{p1['id']}/notes/{note_b['id']}", {"content": "x"})
        check("编辑已删笔记返回 404", st == 404)

        # ---- 自定义变更日志 ----
        today = time.strftime("%Y-%m-%d")
        st, log_a = req("POST", f"/api/projects/{p1['id']}/changelogs",
                        {"title": "v1.1.0 新增导出", "content": "**新增** JSON 导出功能"})
        check("新建变更日志（201，默认当天）", st == 201 and log_a["entry_date"] == today)
        st, log_b = req("POST", f"/api/projects/{p1['id']}/changelogs",
                        {"title": "v1.2.0", "content": "性能优化", "entry_date": "2026-01-01"})
        check("变更日志自定义日期", st == 201 and log_b["entry_date"] == "2026-01-01")
        st, cl = req("GET", f"/api/projects/{p1['id']}/changelogs")
        check("变更日志按日期倒序", [c["entry_date"] for c in cl["changelogs"]] == [today, "2026-01-01"])
        st, up = req("PUT", f"/api/projects/{p1['id']}/changelogs/{log_b['id']}", {"title": "v1.2.1"})
        check("编辑变更日志条目", st == 200 and up["title"] == "v1.2.1" and up["entry_date"] == "2026-01-01")
        st, _ = req("DELETE", f"/api/projects/{p1['id']}/changelogs/{log_b['id']}")
        check("删除变更日志条目", st == 200)
        st, err = req("POST", f"/api/projects/{p1['id']}/changelogs",
                      {"content": "x", "entry_date": "bad-date"})
        check("非法日期返回 422", st == 422)

        # ---- Git 提交记录 ----
        st, cm = req("GET", f"/api/projects/{p1['id']}/commits")
        check("git 提交记录读取", st == 200 and cm["is_repo"]
              and len(cm["commits"]) >= 1 and (cm["total_count"] or 0) >= 1)
        c0 = cm["commits"][0]
        check("提交字段完整（哈希/作者/时间/信息）",
              c0["hash"] and c0["short"] and c0["author"] and c0["date"] and c0["message"])
        st, cm2 = req("GET", f"/api/projects/{p1['id']}/commits?limit=1")
        check("提交记录 limit 生效", st == 200 and len(cm2["commits"]) == 1)

        # ---- 批量扫描与导入 ----
        st, scan = req("POST", "/api/scan", {"root": _temp_root, "max_depth": 2})
        paths = [c["path"] for c in scan["candidates"]]
        check("扫描发现 3 个候选", len(paths) == 3, f"实际 {len(paths)}: {paths}")
        check("扫描不深入 node_modules", not any("node_modules" in p for p in paths))
        st, imp = req("POST", "/api/scan/import",
                      {"paths": [py, cpp], "category": "测试"})
        check("批量导入 2 个", st == 200 and imp["imported"] == 2 and imp["skipped"] == 0)
        _created_ids.extend(range(p1["id"] + 1, p1["id"] + 1 + imp["imported"]))
        st, imp2 = req("POST", "/api/scan/import", {"paths": [py, cpp]})
        check("重复导入被跳过", imp2["skipped"] == 2 and imp2["imported"] == 0)

        # 非 git 目录的提交记录提示
        st, cm3 = req("GET", f"/api/projects/{p1['id'] + 1}/commits")
        check("非 git 目录 is_repo=False", st == 200 and cm3["is_repo"] is False)

        # ---- 列表与统计 ----
        st, lst = req("GET", "/api/projects")
        check("列表统计 total>=3", lst["stats"]["total"] >= 3)

        # ---- 丢失项目检测与路径更新 ----
        shutil.rmtree(py)
        st, lst = req("GET", "/api/projects")
        lost = [p for p in lst["projects"] if p["is_lost"]]
        check("删除文件夹后被标记丢失", len(lost) == 1 and lost[0]["name"] == "demo-python-tool")
        moved_to = os.path.join(_temp_root, "demo-python-moved")
        os.makedirs(moved_to)
        write_moved = os.path.join(moved_to, "main.py")
        with open(write_moved, "w", encoding="utf-8") as f:
            f.write("print('moved')\n")
        st, up = req("PUT", f"/api/projects/{lost[0]['id']}", {"path": moved_to})
        check("更新路径恢复丢失状态", st == 200 and up["is_lost"] is False)

        # ---- 导出 / 渲染 ----
        st, exp = req("GET", "/api/export")
        node_item = next((p for p in exp["projects"] if p["name"] == "demo-node-app"), None)
        check("导出 JSON 备份", st == 200 and len(exp["projects"]) >= 3
              and all("path" in p for p in exp["projects"]))
        check("导出包含自定义笔记与变更日志",
              node_item is not None
              and len(node_item.get("notes", [])) >= 1
              and len(node_item.get("changelogs", [])) >= 1
              and "window" in node_item["notes"][0]["content"])
        st, md = req("POST", "/api/render-md", {"text": "# 标题\n**加粗**", "mode": "notes"})
        check("Markdown 渲染", st == 200 and "<h1" in md["html"] and "<strong>" in md["html"])
        st, md2 = req("POST", "/api/render-md",
                      {"text": "<script>alert(1)</script><b onclick='x()'>hi</b>", "mode": "notes"})
        check("HTML 净化移除脚本", "script" not in md2["html"] and "onclick" not in md2["html"])

        # ---- 页面可达 ----
        st, _ = req("GET", "/")
        check("首页 HTML 可达", st == 200)
        st, _ = req("GET", f"/project/{p1['id']}")
        check("详情页路由可达", st == 200)

    finally:
        cleanup()

    print(f"\n===== 结果：{PASS} 通过，{FAIL} 失败 =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
