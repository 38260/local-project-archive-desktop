"""Pydantic 请求模型定义。"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


def _reject_blank(v: str) -> str:
    """拒绝纯空白内容：min_length 只看原始长度，「  」这类值 strip 后为空，
    路由层 strip 落库会变成空字符串笔记。"""
    if not v.strip():
        raise ValueError("内容不能为空")
    return v


class ProjectCreate(BaseModel):
    """手动录入项目。"""
    path: str = Field(..., description="本地项目文件夹路径（支持 Windows / WSL UNC）")
    name: Optional[str] = None
    alias: str = ""
    category: str = ""
    status: str = "进行中"
    tags: List[str] = []


class ProjectUpdate(BaseModel):
    """更新项目档案（仅数据库字段，不触碰原项目文件）。"""
    path: Optional[str] = None
    name: Optional[str] = None
    alias: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[List[str]] = None
    description: Optional[str] = None


class ScanRequest(BaseModel):
    """批量扫描请求。"""
    root: str
    max_depth: int = Field(3, ge=1, le=8)


class ScanImportRequest(BaseModel):
    """批量导入扫描候选。"""
    paths: List[str]
    category: str = ""
    status: str = "进行中"
    tags: List[str] = []


class OpenRequest(BaseModel):
    """在系统层打开项目（资源管理器 / VSCode）。"""
    target: Literal["explorer", "vscode"]


class RenderRequest(BaseModel):
    """Markdown 渲染预览。"""
    text: str
    mode: Literal["notes", "readme"] = "notes"


class NoteCreate(BaseModel):
    """新建开发笔记。"""
    content: str = Field(..., min_length=1, description="Markdown 正文")
    _not_blank = field_validator("content")(lambda cls, v: _reject_blank(v))


class NoteUpdate(BaseModel):
    """编辑开发笔记。"""
    content: str = Field(..., min_length=1, description="Markdown 正文")
    _not_blank = field_validator("content")(lambda cls, v: _reject_blank(v))


# 允许空串：路由层把空串/缺省补成当天（与「留空取当天」的产品语义一致）
_ENTRY_DATE_RE = r"^(\d{4}-\d{2}-\d{2})?$"


class ChangelogCreate(BaseModel):
    """新建变更日志条目。"""
    title: str = ""
    content: str = Field(..., min_length=1, description="Markdown 正文")
    entry_date: Optional[str] = Field(None, pattern=_ENTRY_DATE_RE,
                                      description="条目日期 YYYY-MM-DD，留空取当天")
    _not_blank = field_validator("content")(lambda cls, v: _reject_blank(v))


class ChangelogUpdate(BaseModel):
    """编辑变更日志条目。"""
    title: Optional[str] = None
    content: Optional[str] = Field(None, min_length=1)
    entry_date: Optional[str] = Field(None, pattern=_ENTRY_DATE_RE)
    _not_blank = field_validator("content")(lambda cls, v: _reject_blank(v) if v is not None else v)


class LaunchNoteUpdate(BaseModel):
    """保存项目启动说明（Markdown）。"""
    note: str = Field("", max_length=20000)


class LauncherCreate(BaseModel):
    """自定义启动项（新增/编辑共用）。"""
    name: str = Field(..., min_length=1, max_length=60)
    command: str = Field(..., min_length=1, max_length=500)
    cwd: str = Field("", max_length=260)
    mode: str = Field("console", pattern="^(console|open)$")
    _not_blank = field_validator("name", "command")(
        lambda cls, v: _reject_blank(v))


class LauncherUpdate(LauncherCreate):
    """编辑自定义启动项（字段与新增一致）。"""
    pass


class LaunchRequest(BaseModel):
    """执行启动：要么指定 launcher_id，要么给完整 command+mode（自动检测直跑用）。"""
    launcher_id: Optional[int] = None
    command: Optional[str] = Field(None, max_length=500)
    mode: Optional[Literal["console", "open"]] = None
    cwd: Optional[str] = Field("", max_length=260)
