"""重复项目检测：同名 / 同 git remote / 同路径，多依据比对已有档案。

背景：入库去重原本只认「路径字符串」，同一项目换个路径（搬家、重命名、
换盘）就会产生重复档案。本模块在路径之外补充两个身份依据：
  - 名称：候选名与已有档案的 name 或其文件夹名相同（不区分大小写）；
  - Git 远端：候选目录的第一个 git remote 与已有档案解析结果相同
    （归一化后比较，ssh/https/scp 写法、.git 后缀、大小写差异均视为同一）。

远端读取走轻量实现（只看 .git 是否存在，再读 remote url），
不做全量解析，供录入/扫描这类高频路径使用。
"""
import json
import os
import re

from app.services.gitinfo import _run_git
from app.services.paths import basename

# scp-like 写法：git@host:path / user@host:path
_SCP_LIKE_RE = re.compile(r"^(?:(?P<user>[^/@:]+)@)?(?P<host>[^/:]+)[:/](?P<path>.+)$")
_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_AUTH_RE = re.compile(r"^[^/@]+@")


def normalize_remote(url: str | None) -> str | None:
    """把 git remote URL 归一化为可比较形式；无法归一化时返回 None。

    https://github.com/u/r.git、git@github.com:u/r.git、
    ssh://git@github.com/u/r.git 均归一为 github.com/u/r。
    """
    u = (url or "").strip()
    if not u:
        return None
    if "://" not in u and (m := _SCP_LIKE_RE.match(u)):
        # scp-like：host + path（冒号后的部分）
        u = m.group("host") + "/" + m.group("path")
    else:
        u = _SCHEME_RE.sub("", u)   # 去 scheme
        u = _AUTH_RE.sub("", u)     # 去认证段（user@ / token@）
    u = u.strip("/").lower()
    if u.endswith(".git"):
        u = u[:-4]
    return u or None


def read_git_remote(path: str) -> str | None:
    """轻量读取目录的第一个 git remote URL（origin 优先）；非 git 目录返回 None。"""
    dotgit = os.path.join(path, ".git")
    if not (os.path.isdir(dotgit) or os.path.isfile(dotgit)):
        return None
    out = _run_git(["remote"], path, timeout=5)
    if not out:
        return None
    names = [l.strip() for l in out.splitlines() if l.strip()]
    if not names:
        return None
    names.sort(key=lambda n: 0 if n == "origin" else 1)  # origin 优先，其次按字母
    url = _run_git(["config", "--get", f"remote.{names[0]}.url"], path, timeout=5)
    return url.strip() if url else None


def build_existing_index(conn, exclude_id: int | None = None) -> list[dict]:
    """把已有档案加载为比对索引（id/name/路径文件夹名/归一化远端）。"""
    rows = conn.execute("SELECT id, name, path, auto_meta FROM projects").fetchall()
    items = []
    for r in rows:
        if exclude_id is not None and r["id"] == exclude_id:
            continue
        try:
            meta = json.loads(r["auto_meta"] or "{}")
        except ValueError:
            meta = {}
        remote = (meta.get("git") or {}).get("remote")
        items.append({
            "id": r["id"], "name": r["name"], "path": r["path"],
            "name_l": (r["name"] or "").strip().lower(),
            "base_l": basename(r["path"]).lower(),
            "remote_n": normalize_remote(remote),
        })
    return items


def match_existing(index: list[dict], *, path: str | None = None,
                   name: str | None = None,
                   remote: str | None = None) -> list[dict]:
    """按 path/name/remote 三个依据比对索引，返回命中的已有档案。

    返回 [{id, name, path, reasons: [...]}]，reasons 取值：path/name/remote。
    name 同时与已有档案的 name 和文件夹名比对（换路径后 name 往往保留原文件夹名）。
    """
    path_l = path.lower() if path else None
    name_l = (name or "").strip().lower()
    remote_n = normalize_remote(remote)
    matches: dict[int, dict] = {}
    for it in index:
        reasons = []
        if path_l and it["path"].lower() == path_l:
            reasons.append("path")
        if name_l and (it["name_l"] == name_l or it["base_l"] == name_l):
            reasons.append("name")
        if remote_n and it["remote_n"] == remote_n:
            reasons.append("remote")
        if not reasons:
            continue
        m = matches.setdefault(it["id"], {"id": it["id"], "name": it["name"],
                                          "path": it["path"], "reasons": []})
        for reason in reasons:
            if reason not in m["reasons"]:
                m["reasons"].append(reason)
    return list(matches.values())


def reasons_text(reasons: list[str]) -> str:
    """命中依据 → 中文说明（弹窗/徽标用）。"""
    labels = {"path": "同路径", "name": "同名", "remote": "同一 Git 远端"}
    return " / ".join(labels.get(r, r) for r in reasons)
