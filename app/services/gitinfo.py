"""Git 信息读取服务：基于 GitPython，只读操作，绝不写入用户仓库。

任何异常都被捕获并降级为 is_repo=False 或带 error 的部分结果，保证无 git
环境 / 非 git 目录 / 损坏仓库都不会影响服务运行。
"""
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

try:
    from git import InvalidGitRepositoryError, NoSuchPathError, Repo
    _GITPY_AVAILABLE = True
except ImportError:  # GitPython 未安装时优雅降级
    _GITPY_AVAILABLE = False


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


def collect_commit_log(path: str, limit: int = 50) -> dict:
    """读取 git 提交记录（时间线可视化用），只读操作。

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

        for commit in repo.iter_commits(max_count=limit):
            entry = {
                "hash": commit.hexsha,
                "short": commit.hexsha[:8],
                "author": commit.author.name,
                "email": commit.author.email,
                "date": commit.committed_datetime.isoformat(),
                "message": (commit.message or "").strip(),
                "stats": None,
            }
            # 变更规模（文件数/增删行数），失败时留空不影响整体
            try:
                total = commit.stats.total
                entry["stats"] = {
                    "files": total.get("files", 0),
                    "insertions": total.get("insertions", 0),
                    "deletions": total.get("deletions", 0),
                }
            except Exception:
                pass
            result["commits"].append(entry)
    except ValueError:
        # 空仓库（尚无任何提交）时 iter_commits 抛 ValueError
        result["error"] = "仓库还没有任何提交"
    except Exception as exc:
        result["error"] = f"提交记录读取失败：{exc}"
    return result


def format_time_local(dt: datetime) -> str:
    """datetime 转 ISO 字符串（本地时区）。"""
    return dt.astimezone().isoformat()
