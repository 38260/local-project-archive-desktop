"""Git 信息读取服务：GitPython 定位仓库 + 带超时的 git 子进程，只读操作。

绝不写入用户仓库。任何异常都被捕获并降级为 is_repo=False 或带 error 的
部分结果，保证无 git 环境 / 非 git 目录 / 损坏仓库 / 网络盘挂死都不会影响
服务运行。
"""
import logging
import os
import re
import subprocess
from datetime import date, datetime, timedelta

from app.config import (COMMIT_STATS_MAX, COMMIT_STATS_PREFIX_LIMIT,
                        COMMIT_STATS_TYPE_LIMIT)

logger = logging.getLogger(__name__)

try:
    from git import InvalidGitRepositoryError, NoSuchPathError, Repo
    _GITPY_AVAILABLE = True
except ImportError:  # GitPython 未安装时优雅降级
    _GITPY_AVAILABLE = False

# 单条 git 命令超时（秒）：网络盘 / 异常仓库不再挂住解析
_GIT_TIMEOUT = 15


def _run_git(args: list[str], cwd: str, timeout: int = _GIT_TIMEOUT) -> str | None:
    """以子进程执行只读 git 命令，返回 stdout；失败或超时返回 None。

    不走 GitPython 的 repo.git 调用：其 kill_after_timeout 在 Windows 上
    不受支持（直接抛错），而 subprocess 自带的 timeout 在 Windows 下同样
    能强制结束进程。
    """
    extra = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                           stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, **extra)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None

# numstat 行：新增行数 \t 删除行数 \t 文件路径（二进制文件为 -）
_NUMSTAT_RE = re.compile(r"^(\d+|-)\t(\d+|-)\t(.+)$")


def collect_git_info(path: str) -> dict:
    """读取指定目录的 git 基础信息（分支、最近提交、提交总数、远端、历史概况）。"""
    result = {"is_repo": False, "branch": None, "last_commit": None,
              "commit_count": None, "remote": None,
              "first_commit_date": None, "branches": [], "contributors": []}
    if not _GITPY_AVAILABLE:
        result["error"] = "GitPython 未安装，无法读取 git 信息"
        return result

    try:
        repo = Repo(path)  # 默认不在父目录中搜索，仅在给定目录找 .git
    except (InvalidGitRepositoryError, NoSuchPathError):
        return result
    except Exception as exc:  # 其他未知异常不中断解析
        logger.debug("git 信息读取失败 %s: %s", path, exc)
        result["error"] = f"git 信息读取失败：{exc}"
        return result

    result["is_repo"] = True
    try:
        # 分支：普通分支取名称；分离 HEAD 状态给出短哈希
        try:
            result["branch"] = repo.active_branch.name
        except (TypeError, ValueError):
            result["branch"] = f"HEAD detached @ {repo.head.commit.hexsha[:7]}"

        # 本地分支列表（最多 10 个）
        try:
            result["branches"] = [h.name for h in list(repo.heads)[:10]]
        except Exception:
            pass

        commit = repo.head.commit
        result["last_commit"] = {
            "hash": commit.hexsha[:8],
            "author": commit.author.name,
            # 统一输出带时区的 ISO 字符串，便于前端格式化
            "date": commit.committed_datetime.isoformat(),
            "message": (commit.message or "").strip().splitlines()[0][:120]
            if (commit.message or "").strip() else "",
        }

        # 提交总数：走 git 命令比遍历对象快得多；超时/失败降级为不计
        raw = _run_git(["rev-list", "--count", "HEAD"], path)
        if raw:
            try:
                result["commit_count"] = int(raw.strip())
            except ValueError:
                pass

        # 首次提交时间 = 根提交中最早的时间（即项目真正开始的日子）
        raw = _run_git(["rev-list", "--max-parents=0", "HEAD"], path)
        if raw:
            try:
                dates = [repo.commit(h).committed_datetime for h in raw.split()]
                if dates:
                    result["first_commit_date"] = min(dates).isoformat()
            except Exception:
                pass

        # 贡献者统计（按提交数取前 5）
        raw = _run_git(["shortlog", "-s", "HEAD"], path)
        if raw:
            contribs = []
            for line in raw.splitlines():
                parts = line.strip().split("\t", 1)
                if len(parts) == 2 and parts[0].strip().isdigit():
                    contribs.append({"name": parts[1].strip(),
                                     "commits": int(parts[0])})
            result["contributors"] = sorted(contribs, key=lambda c: -c["commits"])[:5]

        # 第一个远端地址（通常为 origin）
        try:
            if repo.remotes:
                result["remote"] = repo.remotes[0].url
        except Exception:
            pass
    except Exception as exc:
        logger.debug("git 元数据读取不完整 %s: %s", path, exc)
        result["error"] = f"git 元数据读取不完整：{exc}"

    return result


def collect_commit_log(path: str, limit: int = 50, date: str | None = None) -> dict:
    """读取 git 提交记录（时间线可视化用），只读操作。

    date 传 "YYYY-MM-DD" 时只返回当天（提交时区）的提交，供热力图点击查看。
    一次 `git log --numstat` 取回提交与变更规模，避免逐提交算 diff（大仓库慢）。
    返回 {is_repo, total_count, commits: [{hash, short, author, email, date,
    message, stats}], error}；非 git 目录时 is_repo=False。
    """
    result = {"is_repo": False, "total_count": None, "commits": [], "error": None}
    if not _GITPY_AVAILABLE:
        result["error"] = "GitPython 未安装，无法读取 git 信息"
        return result

    try:
        repo = Repo(path)
    except (InvalidGitRepositoryError, NoSuchPathError):
        return result
    except Exception as exc:
        result["error"] = f"git 读取失败：{exc}"
        return result

    result["is_repo"] = True
    raw = _run_git(["rev-list", "--count", "HEAD"], path)
    if raw:
        try:
            result["total_count"] = int(raw.strip())
        except ValueError:
            pass

    # 指定日期时只取当天（00:00–23:59），不受条数上限影响语义
    date_args = []
    if date:
        date_args = [f"--since={date} 00:00:00", f"--until={date} 23:59:59"]

    # \x1e 分隔提交，\x1f 分隔字段；%B 为完整提交信息，其后跟 numstat 行
    raw = _run_git(["log", f"--max-count={limit}", "--numstat", *date_args,
                    "--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%cI%x1f%B"], path)
    if raw is None:
        # rev-list --count 同样失败多半是空仓库（尚无任何提交），否则按超时/异常降级
        result["error"] = ("仓库还没有任何提交" if result["total_count"] is None
                           else "提交记录读取失败（git 命令超时或异常）")
        return result
    try:
        for block in raw.split("\x1e"):
            if not block.strip():
                continue
            parts = block.split("\x1f", 4)
            if len(parts) < 5:
                continue
            c_hash, author, email, date, rest = parts
            # rest = 完整提交信息 + 空行 + numstat 行 + 尾部空行；从尾部收集 numstat
            lines = rest.splitlines()
            while lines and not lines[-1].strip():
                lines.pop()   # 先剥掉 numstat 块之后的空行
            files = insertions = deletions = 0
            while lines:
                m = _NUMSTAT_RE.match(lines[-1].strip())
                if not m:
                    break
                lines.pop()
                files += 1
                if m.group(1) != "-":
                    insertions += int(m.group(1))
                if m.group(2) != "-":
                    deletions += int(m.group(2))
            # numstat 与提交信息之间隔着一个空行，吃掉它
            while lines and not lines[-1].strip():
                lines.pop()
            entry = {
                "hash": c_hash,
                "short": c_hash[:8],
                "author": author,
                "email": email,
                "date": date,
                "message": "\n".join(lines).strip(),
                "stats": {"files": files, "insertions": insertions,
                          "deletions": deletions} if files else None,
            }
            result["commits"].append(entry)
    except Exception as exc:
        result["error"] = f"提交记录解析失败：{exc}"
    return result


def collect_heatmap(path: str, weeks: int = 53) -> dict:
    """按天聚合最近 N 周的全部提交次数（GitHub 风格贡献热力图数据源）。

    与 collect_commit_log 的 200 条上限无关：这里只取提交日期不展开 diff，
    一年数千次提交也在毫秒级。--since 限定到网格起点（约 weeks 周），
    超大仓库不再全历史遍历；前端按月柱状图最多聚合 12 个日历月，网格
    起点比它更早几天，覆盖足够。author 日期早于 since 的少量越界提交
    仍由前端按范围过滤。
    """
    from datetime import date, timedelta

    result = {"is_repo": False, "days": {}, "total": 0, "weeks": weeks,
              "start": None, "end": None}
    if not _GITPY_AVAILABLE:
        result["error"] = "GitPython 未安装，无法读取 git 信息"
        return result
    try:
        repo = Repo(path)
    except (InvalidGitRepositoryError, NoSuchPathError):
        return result
    except Exception as exc:
        logger.debug("热力图读取失败 %s: %s", path, exc)
        result["error"] = f"git 信息读取失败：{exc}"
        return result

    result["is_repo"] = True
    try:
        today = date.today()
        # 网格终点 = 本周周日；起点 = weeks 周前的周日（周日起始，与 GitHub 一致）
        end = today + timedelta(days=(6 - today.weekday()) % 7 if today.weekday() != 6 else 0)
        start = end - timedelta(days=7 * weeks - 1)
        days: dict = {}
        # %cI = committer 日期（严格 ISO）；--since 限定到网格起点，避免全历史遍历
        raw = _run_git(["log", "--pretty=format:%cI", f"--since={start.isoformat()}"], path)
        if raw is None:
            result["error"] = "提交历史读取失败（仓库为空或 git 命令超时）"
            return result
        for line in raw.splitlines():
            line = line.strip()
            if len(line) < 10:
                continue
            try:
                d = date.fromisoformat(line[:10])
            except ValueError:
                continue
            if d > end:
                continue
            key = d.isoformat()
            n = days.get(key)
            days[key] = 1 if n is None else n + 1
        # 范围内提交总数（范围外的历史提交不计入网格与总数）
        total = sum(n for k, n in days.items() if date.fromisoformat(k) >= start)
        result["days"] = days
        result["total"] = total
        result["start"] = start.isoformat()
        result["end"] = end.isoformat()
    except Exception as exc:
        logger.debug("热力图聚合失败 %s: %s", path, exc)
        result["error"] = f"热力图聚合失败：{exc}"
    return result


# ---------------------------------------------------------------------------
# 提交构成分析：分类计数 + 发力点（类型分布 / 类型 × 月份）
# ---------------------------------------------------------------------------

# Conventional Commits 白名单。前端 common.js 的 commitType() 用同一套前缀，
# 但**权威口径以后端为准**（前端在新数据到达后改为取后端结果），避免两处漂移。
_COMMIT_TYPE_RE = re.compile(
    r"^\s*(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert|merge)\b",
    re.I)

# 白名单类型名集合：正则只能正向匹配，判定"是否自造前缀"需要反向查一份名单
_KNOWN_TYPES = frozenset((
    "feat", "fix", "docs", "style", "refactor", "perf", "test",
    "chore", "build", "ci", "revert", "merge",
))

# 未登记前缀：形如 `design: xxx` / `security：xxx`（中英文冒号都认）。
# 本仓库实测就有 design/security/init 这类自造前缀，若直接丢进 other 会埋掉
# 真实的工作类型，因此这里**以前缀名本身成类**。
_PREFIX_RE = re.compile(r"^\s*([a-z][a-z0-9_-]{1,14})\s*[:：]\s*\S", re.I)

# 无前缀提交的兜底关键词（弱分类）。顺序即优先级：越具体的规则越靠前。
# 结果只用于数据留痕（weak_inferred），界面上默认**不展示**——关键词猜测的
# 误判会直接污染「主要发力点」这个结论，代价大于收益。
_WEAK_RULES = (
    ("fix", ("修复", "修正", "解决", "故障", "报错", "崩溃", "bug", "hotfix")),
    ("refactor", ("重构", "整理结构", "优化结构", "重写")),
    ("perf", ("性能", "提速", "卡顿")),
    ("docs", ("文档", "readme", "注释", "说明")),
    ("style", ("样式", "排版", "美化", "css")),
    ("test", ("测试", "用例")),
    ("chore", ("依赖", "升级", "版本", "bump")),
    ("feat", ("新增", "添加", "支持", "实现", "增加")),
)


def classify_commit(subject: str) -> tuple[str, bool]:
    """把提交首行归类，返回 (类型, 是否为弱分类推断)。

    三级口径（顺序不可调换）：
      1. Conventional 白名单命中 → 直接用该类型；
      2. 未登记前缀（`design:` 等）→ 以前缀名本身成类；
      3. 无前缀 → 关键词弱分类，标记 inferred=True；仍判不出则归 "other"。
    """
    text = (subject or "").strip()
    if not text:
        return "other", False
    m = _COMMIT_TYPE_RE.match(text)
    if m:
        return m.group(1).lower(), False
    m = _PREFIX_RE.match(text)
    if m:
        return m.group(1).lower(), False
    lowered = text.lower()
    for ctype, words in _WEAK_RULES:
        if any(w in lowered for w in words):
            return ctype, True
    return "other", False


def _is_known_type(ctype: str) -> bool:
    """是否为白名单内的 Conventional 类型；否则视为自造前缀。"""
    return ctype in _KNOWN_TYPES


def collect_commit_stats(path: str, scope: str = "all",
                         include_merges: bool = False,
                         max_commits: int = COMMIT_STATS_MAX) -> dict:
    """聚合提交构成，供详情页「提交构成分析」（分类计数 + 发力点）。

    只取「提交时间 + 首行」两个字段，**不带 --numstat/diff**——与 collect_heatmap
    同一路线，几千条提交也在毫秒级。这是本方案能做到「全量」而不是「最近 200 条」
    的前提：一旦带上 diff，十万级提交的仓库就会明显变慢。

    只读；任何异常都降级为带 error 的空结果，不影响调用方其它面板。

    返回：
      is_repo / scanned（参与统计的提交数）/ truncated / scope / include_merges /
      types: [{type, count, pct, weak}]（按 count 倒序，Σcount == scanned）/
      months: [{key, total, types: {类型: 次数}}]（升序）/
      type_order（月份分段用的稳定顺序）/
      active_days / busiest_month / first_date / last_date / error
    """
    result = {"is_repo": False, "scanned": 0, "truncated": False,
              "scope": scope, "include_merges": include_merges,
              "types": [], "type_order": [], "months": [],
              "active_days": 0, "busiest_month": None,
              "first_date": None, "last_date": None, "error": None}
    if not _GITPY_AVAILABLE:
        result["error"] = "GitPython 未安装，无法读取 git 信息"
        return result
    try:
        Repo(path)   # 同样的定位方式，非仓库/路径不存在直接降级
    except (InvalidGitRepositoryError, NoSuchPathError):
        return result
    except Exception as exc:
        logger.debug("提交构成分析失败 %s: %s", path, exc)
        result["error"] = f"git 信息读取失败：{exc}"
        return result

    result["is_repo"] = True
    try:
        args = ["log", f"--max-count={max_commits + 1}",   # 多取 1 条用于判断截断
                "--pretty=format:%cI%x1f%s"]
        # 合并提交用 git 自己的 --no-merges 排除（按父提交数判定），
        # 比"看 subject 是不是以 Merge 开头"准确；白名单里的 merge 类型
        # 仍然保留，用于单亲提交但写了 merge: 前缀的情况。
        if not include_merges:
            args.append("--no-merges")
        if scope == "year":
            since = date.today() - timedelta(days=365)
            args.append(f"--since={since.isoformat()}")

        raw = _run_git(args, path)
        if raw is None:
            result["error"] = "提交历史读取失败（仓库为空或 git 命令超时）"
            return result

        type_counts: dict[str, int] = {}
        weak_counts: dict[str, int] = {}
        months: dict[str, dict] = {}
        days: set = set()
        scanned = 0
        for line in raw.splitlines():
            if not line.strip():
                continue
            if scanned >= max_commits:
                result["truncated"] = True
                break
            iso, _, subject = line.partition("\x1f")
            iso = iso.strip()
            if len(iso) < 10:
                continue
            scanned += 1
            ctype, inferred = classify_commit(subject)
            type_counts[ctype] = type_counts.get(ctype, 0) + 1
            if inferred:
                weak_counts[ctype] = weak_counts.get(ctype, 0) + 1
            day, month = iso[:10], iso[:7]
            days.add(day)
            slot = months.setdefault(month, {"total": 0, "types": {}})
            slot["total"] += 1
            slot["types"][ctype] = slot["types"].get(ctype, 0) + 1

        if not scanned:
            result["error"] = "仓库还没有任何提交"
            return result

        # 类别收敛（两道，都只做「并类」，不改动任何计数总和）：
        #   ① 超出展示上限的尾部 → 「其他」（各种类按 count 倒序，同数时白名单类型
        #      优先，避免自造前缀把标准类型挤下去）；
        #   ② 白名单外的自造前缀最多单列 PREFIX_LIMIT 个，多余的也 → 「其他」。
        # 先求出「原类型名 → 最终类型名」的唯一映射，再据此归并月份分段，
        # 保证同一根柱子里各段之和 == 该月总数（数值守恒）。
        ranked = sorted(type_counts.items(),
                        key=lambda kv: (-kv[1], 0 if _is_known_type(kv[0]) else 1, kv[0]))
        keep = ({t for t, _ in ranked[:COMMIT_STATS_TYPE_LIMIT - 1]}
                if len(ranked) > COMMIT_STATS_TYPE_LIMIT
                else {t for t, _ in ranked})
        unknown = [t for t, _ in ranked if t in keep and not _is_known_type(t)]
        demote = set(unknown[COMMIT_STATS_PREFIX_LIMIT:])

        def final_name(ctype: str) -> str:
            """原类型 → 最终展示类型名（未保留的一律并入「其他」）。"""
            return ctype if (ctype in keep and ctype not in demote) else "other"

        merged: dict[str, int] = {}
        weak_merged: dict[str, int] = {}
        for ctype, n in type_counts.items():
            fname = final_name(ctype)
            merged[fname] = merged.get(fname, 0) + n
            if weak_counts.get(ctype):
                weak_merged[fname] = weak_merged.get(fname, 0) + weak_counts[ctype]

        order = [t for t, _ in sorted(merged.items(), key=lambda kv: (-kv[1], kv[0]))]
        result["type_order"] = order
        result["types"] = [
            {"type": t, "count": merged[t],
             "pct": round(merged[t] * 100.0 / scanned, 1),
             "weak": weak_merged.get(t, 0)}
            for t in order]
        result["months"] = []
        for key, slot in sorted(months.items()):
            seg: dict[str, int] = {}
            for ctype, n in slot["types"].items():
                fname = final_name(ctype)
                seg[fname] = seg.get(fname, 0) + n
            result["months"].append({
                "key": key, "total": slot["total"],
                "types": {t: seg[t] for t in order if seg.get(t)},
            })
        result["scanned"] = scanned
        result["active_days"] = len(days)
        result["first_date"] = min(days)
        result["last_date"] = max(days)
        if result["months"]:
            result["busiest_month"] = max(result["months"],
                                          key=lambda m: m["total"])["key"]
    except Exception as exc:
        logger.debug("提交构成分析失败 %s: %s", path, exc)
        result["error"] = f"提交构成分析失败：{exc}"
    return result


def format_time_local(dt: datetime) -> str:
    """datetime 转 ISO 字符串（本地时区）。"""
    return dt.astimezone().isoformat()
