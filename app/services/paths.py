"""路径规范化服务：Windows 原生路径与 WSL 路径统一处理。

支持形式：
  - D:\\code\\proj  /  D:/code/proj
  - 带引号的 "D:\\code\\proj"（资源管理器“复制文件地址”常带引号）
  - \\\\wsl$\\Ubuntu\\home\\user\\proj
  - \\\\wsl.localhost\\Ubuntu\\home\\user\\proj
  - wsl:Ubuntu:/home/user/proj  /  wsl://Ubuntu/home/user/proj
  - ~ 或 ~user（展开为当前用户主目录）
"""
import os
from pathlib import Path, PureWindowsPath


class PathError(ValueError):
    """路径无效异常，由路由层转换为友好的 400 响应。"""


def normalize_input_path(raw: str) -> str:
    """将用户输入的各种路径形式规范化为本机可访问的绝对路径。"""
    if raw is None:
        raise PathError("路径不能为空")
    path = raw.strip().strip('"').strip("'").strip()
    if not path:
        raise PathError("路径不能为空")

    # WSL 前缀形式：wsl:发行版:/绝对路径 或 wsl://发行版/绝对路径
    lowered = path.lower()
    if lowered.startswith("wsl:") or lowered.startswith("wsl://"):
        path = _convert_wsl_prefix(path)

    # 主目录展开
    if path == "~" or path.startswith("~\\") or path.startswith("~/"):
        path = os.path.expanduser(path)

    # 统一分隔符后规范化（pathlib 对 UNC 路径同样适用）
    path = path.replace("/", "\\") if _looks_like_windows(path) else path
    try:
        norm = str(Path(os.path.normpath(path)))
    except (ValueError, OSError) as exc:
        raise PathError(f"路径格式无法解析：{exc}") from exc

    if not os.path.isabs(norm):
        raise PathError(f"请输入绝对路径，当前输入：{raw}")

    return norm


def _looks_like_windows(path: str) -> bool:
    """判断是否按 Windows 路径处理（盘符 / UNC / 反斜杠）。"""
    if len(path) >= 2 and path[1] == ":":
        return True
    return path.startswith("\\\\") or "\\" in path


def _convert_wsl_prefix(path: str) -> str:
    """将 wsl: 前缀写法转换为 \\\\wsl.localhost\\发行版\\... 的 UNC 路径。"""
    body = path[4:] if path.lower().startswith("wsl:") else path[6:]
    body = body.lstrip("\\/").strip()
    if not body:
        raise PathError(
            'WSL 路径格式：wsl:发行版:/home/user/project，'
            '或直接使用 \\\\wsl.localhost\\Ubuntu\\home\\user\\project'
        )
    distro, _, rest = body.replace("\\", "/").partition("/")
    if not distro or not rest:
        raise PathError(
            "WSL 路径需要同时给出发行版与项目绝对路径，"
            "例如 wsl:Ubuntu:/home/user/project"
        )
    # ~ 指向发行版内当前用户主目录，UNC 下可写为 \\wsl.localhost\<distro>\home\<user>
    if rest.startswith("~/") or rest == "~":
        rest = "home/" + rest.lstrip("~/")
    return f"\\\\wsl.localhost\\{distro}\\{rest.replace('/', '\\')}"


def is_wsl_path(path: str) -> bool:
    """判断路径是否位于 WSL 文件系统。"""
    lowered = path.lower()
    return lowered.startswith("\\\\wsl$\\") or lowered.startswith("\\\\wsl.localhost\\")


def is_valid_dir(path: str) -> bool:
    """路径是否存在且为目录。"""
    return os.path.isdir(path)


def dir_not_exists_hint(path: str) -> str:
    """路径不存在时的提示语。"""
    if is_wsl_path(path):
        return "路径不存在。若为 WSL 路径，请确认发行版名称正确且 WSL 实例已启动。"
    return "路径不存在，项目文件夹可能已被删除或移动。"


def basename(path: str) -> str:
    """取路径末级目录名作为默认项目名。"""
    return PureWindowsPath(path).name or path
