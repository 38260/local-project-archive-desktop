"""Git 信息读取服务：基于 GitPython，只读操作，绝不写入用户仓库。

任何异常都被捕获并降级为 is_repo=False 或带 error 的部分结果，保证无 git
环境 / 非 git 目录 / 损坏仓库都不会影响服务运行。
"""
import logging
import re
from datetime import datetime

logger = logging.getLogger(__name__)

try:
    from git import InvalidGitRepositoryError, NoSuchPathError, Repo
    from git.exc import GitCommandError
    _GITPY_AVAILABLE = True
except ImportError:  # GitPython 未安装时优雅降级
    _GITPY_AVAILABLE = False

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

        # 提交总数：走 git 命令比遍历对象快得多
        try:
            result["commit_count"] = int(repo.git.rev_list("--count", "HEAD").strip())
        except Exception:
            pass

        # 首次提交时间 = 根提交中最早的时间（即项目真正开始的日子）
        try:
            roots = repo.git.rev_list("--max-parents=0", "HEAD").split()
            dates = [repo.commit(h).committed_datetime for h in roots]
            if dates:
                result["first_commit_date"] = min(dates).isoformat()
        except Exception:
            pass

        # 贡献者统计（按提交数取前 5）
        try:
            raw = repo.git.shortlog("-s", "HEAD")
            contribs = []
            for line in raw.splitlines():
                parts = line.strip().split("\t", 1)
                if len(parts) == 2 and parts[0].strip().isdigit():
                    contribs.append({"name": parts[1].strip(),
                                     "commits": int(parts[0])})
            result["contributors"] = sorted(contribs, key=lambda c: -c["commits"])[:5]
        except Exception:
            pass

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
    try:
        try:
            result["total_count"] = int(repo.git.rev_list("--count", "HEAD").strip())
        except Exception:
            pass

        # 指定日期时只取当天（00:00–23:59），不受条数上限影响语义
        date_args = []
        if date:
            date_args = [f"--since={date} 00:00:00", f"--until={date} 23:59:59"]

        # \x1e 分隔提交，\x1f 分隔字段；%B 为完整提交信息，其后跟 numstat 行
        raw = repo.git.log(
            f"--max-count={limit}", "--numstat", *date_args,
            "--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%cI%x1f%B")
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
    except GitCommandError:
        # 空仓库（尚无任何提交）时 git log 直接失败
        result["error"] = "仓库还没有任何提交"
    except Exception as exc:
        result["error"] = f"提交记录读取失败：{exc}"
    return result


def collect_heatmap(path: str, weeks: int = 53) -> dict:
    """按天聚合最近 N 周的全部提交次数（GitHub 风格贡献热力图数据源）。

    与 collect_commit_log 的 200 条上限无关：这里只遍历提交对象取日期，
    不展开 diff，一年数千次提交也在毫秒级。author 日期可能早于 since 的
    少量越界提交由前端按范围过滤。
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
        for c in repo.iter_commits():
            d = c.committed_datetime.date()
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


def format_time_local(dt: datetime) -> str:
    """datetime 转 ISO 字符串（本地时区）。"""
    return dt.astimezone().isoformat()
