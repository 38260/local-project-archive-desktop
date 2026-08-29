"""Markdown 渲染与基础净化。

本系统仅在本机运行、渲染内容来自用户自己的本地文件，风险较低；但 README
等第三方内容仍可能包含脚本，这里做一层基础净化：移除 script/style/iframe 等
标签与 on* 事件属性、javascript: 链接，保证浏览器内不会执行外部脚本。
"""
import re

import markdown as _markdown

# 用户笔记：启用换行转 <br>，纯文本笔记观感更好
_NOTES_EXTENSIONS = ["fenced_code", "tables", "nl2br", "sane_lists"]
# README：贴近 GitHub 渲染习惯，不启用 nl2br
_README_EXTENSIONS = ["fenced_code", "tables", "sane_lists"]

# 需要整体移除的标签（含内容）
_BLOCK_TAGS = ("script", "style", "iframe", "object", "embed", "link", "meta", "base")
_BLOCK_RE = re.compile(
    r"<\s*(%s)\b[^>]*>.*?<\s*/\s*\1\s*>" % "|".join(_BLOCK_TAGS), re.I | re.S
)
_BLOCK_SELF_RE = re.compile(r"<\s*(%s)\b[^>]*/?\s*>" % "|".join(_BLOCK_TAGS), re.I)
# 事件属性 onxxx="..." / onxxx='...' / onxxx=xxx
_ON_ATTR_RE = re.compile(r'\son[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)', re.I)
# javascript: 伪协议链接
_JS_URL_RE = re.compile(r'((?:href|src)\s*=\s*)(["\'])\s*javascript:[^"\']*\2', re.I)


def sanitize_html(html: str) -> str:
    """移除可执行内容，返回净化后的 HTML。"""
    html = _BLOCK_RE.sub("", html)
    html = _BLOCK_SELF_RE.sub("", html)
    html = _ON_ATTR_RE.sub("", html)
    html = _JS_URL_RE.sub(r"\1\2#\2", html)
    return html


def render_markdown(text: str, mode: str = "notes") -> str:
    """Markdown 转 HTML 并净化。mode: notes=用户笔记 / readme=项目说明文件。"""
    if not text:
        return ""
    extensions = _NOTES_EXTENSIONS if mode == "notes" else _README_EXTENSIONS
    html = _markdown.markdown(text, extensions=extensions, output_format="html5")
    return sanitize_html(html)
