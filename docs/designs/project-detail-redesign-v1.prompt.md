# Project detail redesign v1 — imagegen prompt

生成方式：内置 `image_gen.imagegen`，单张新生成，无图片输入。沿用首页第二版的视觉语言，设计项目详情的概览分区；全部内容与统计均为演示数据。

```text
Use case: ui-mockup
Asset type: high-fidelity Chinese desktop application PROJECT DETAIL PAGE design preview for “归迹拾光 / Tracelight”.
Primary request: create ONE polished and practical project detail overview screen implementing the user's agreed visual direction: compact project identity header, four project-internal navigation sections, a wide readable overview that helps resume work, a single primary action, and an on-demand file tree that is CLOSED by default.

This is a NEW project-detail screen, not a homepage. Do not draw the homepage project grid, category filter navigation, global project totals, or global multi-project weekly chart. The screen belongs to the same product family as its revised homepage: white panels, pale cool-gray #F6F7F9 canvas, cobalt #0969DA actions, deep charcoal text, slate secondary text, subtle cool-gray borders, 10–12px radii, restrained shadows, coherent small outline icons, crisp Chinese sans-serif typography. No marketing hero, gradient background, glassmorphism, decorative illustration, large empty KPI cards, user avatar, cloud-sync features, AI-generated-summary widget, or invented productivity score.

Output framing: one full-screen front-on desktop application UI, landscape around 1700 x 1120 with approximately 3:2 proportions, high resolution and very readable Simplified Chinese. Fill the canvas with the application screen. No monitor/laptop frame, perspective, annotations, arrows, watermark, surrounding scenery, or detached screen fragments. All requested panels and bottom content must fit without awkward cropping.

Layout and exact text:

1. Preserve the slim top open-project tab strip, approximately 36px tall.
Tabs: “首页”, selected “Tracelight” with small blue icon and close affordance, then “WindowAnchor”, “SkillManager”, and a subtle plus icon. This is a project workspace with its own local navigation.

2. Global header approximately 64px tall, white with fine bottom border.
Left: small cobalt folder/code mark, brand “归迹拾光”, smaller “Tracelight”.
Next to brand, a muted caption “本机索引库 · 数据不出本机”.
On the right: outlined “目录树” button with folder-tree icon, settings icon, and appearance icon.
Do not put bulk scan/import/new-project actions on this detail page.
The “目录树” control is a CLOSED on-demand drawer trigger. No permanently visible file-tree panel and no blank reserved right sidebar.

3. Under global header, fixed-width light sidebar approximately 220px, thin vertical divider. Main content fills the remaining width with 28px outer spacing.
Sidebar:
- top back link with arrow “返回项目库”.
- heading “项目导航”.
- four distinct roomy navigation rows with outline icons:
  selected “概览” in light-blue background with cobalt icon/text,
  “启动与运行”,
  “开发记录”,
  “项目资料”.
All four rows must be visible simultaneously.
- fine divider, small secondary heading “本页内容”; quieter anchor links “最近进展”, “最近笔记”, “常用启动”, “项目简介”. These are subordinate anchors for the currently selected overview, not duplicate top-level tabs.
- bottom green dot and “本地运行中”.
Do not show the homepage's project-status filters or common-tag filters here.

4. Main content starts with a quiet breadcrumb “项目库 / Tracelight”, followed by one COMPACT PROJECT IDENTITY HEADER panel about 170–190px tall.
Inside this panel:
- a consistent rounded-square cobalt MONOGRAM badge “TL” about 44px at left.
- bold project name “Tracelight” at approximately 26px; smaller alias “归迹拾光” alongside.
- one-line description “本地项目归档与快速启动”.
- modest chips “桌面应用”, “Python”, “Vue”, “FastAPI”, and current branch icon/label “main”.
- show the path EXACTLY ONCE: “D:/Projects/Tracelight” in smaller monospace, folder icon at left and small inline copy icon at right.
- status dropdown “进行中” and a small blue pin icon in the upper right.
- a clear action row on the right/bottom: only “⚡ 启动” with dropdown caret is solid cobalt primary; “编辑器打开” and “资源管理器” are outlined secondary buttons; “更多” is quiet.
Use an outline lightning icon rather than a literal emoji.
- subdued small metadata “最近修改：今天 10:42” and small text control “更多信息”.
Do not repeat the project path or current status in additional basic-information cards.
Do not fill the header with creation time / archive time / update time tiles.
No “last opened yesterday” label here: the detail-page visit event itself may already have updated that timestamp; last-opened is a separate homepage feature.

5. OVERVIEW CONTENT uses a broad main area, without the old permanent right file tree.
The next row contains TWO balanced panels, with “最近进展” taking about 60% of main area and “最近笔记” about 40%. Same height, approximately 275px. These are content panels, not a rigid persistent right rail.

LEFT PANEL “最近进展”:
- heading “最近进展”; small scope “近 7 天 · 仅本人”; right link “全部提交 ›”.
- at top, a compact summary “18 次本人提交 · 4 个活跃日”.
- a small, shallow blue 7-day bar rhythm graphic, not a giant chart and not calendar squares. Values for 10/16, 10/17, 10/18, 10/19, 10/20, 10/21, 今天 are 0, 4, 5, 0, 6, 3, 0, totaling 18. Zero days are baseline ticks. Today's label has a subtle cobalt outline.
Because this screen is one project, use the same Tracelight cobalt blue for this project's bars. Do not add the homepage's green/purple projects to this chart.
- below chart, 3 concise recent-commit timeline rows, modest type pills and small timestamps:
“feat” — “记录项目详情成功打开时间” — “今天 10:42”
“fix” — “优化项目卡片布局” — “昨天 18:20”
“feat” — “完善后台自动更新” — “10月20日”
Keep the commit text and timestamp readable; avoid a dense code or debug log here.
- Differentiate commit-type badges subtly while keeping project identity consistent.

RIGHT PANEL “最近笔记”:
- heading “最近笔记”; small outlined “新增笔记” action.
- one existing-note preview, NOT an AI summary:
  title “首页改版下一步”
  small timestamp “昨天 18:35”
  body “状态与常用标签同时显示。”
  next line “每日节奏与项目颜色保持对应。”
  next line “完成后检查排序与拖动。”
- small muted notebook icon or note rule, generous readable line spacing.
- footer link “查看全部笔记 ›”.
Do not insert an editor, textarea, or modal into this overview preview.

6. Under that row, one full-width content panel “常用启动”, approximately 185–210px tall.
Heading at left “常用启动”, right text link “全部启动项 ›”.
Inside show TWO tidy launch-entry cards side by side, using a subtle pale-gray inset background and a thin border:
A. title “浏览器模式”, small badge “自动检测”, command “.venv/Scripts/python.exe run.py” in readable monospace, small outline terminal icon, a modest outlined “启动” button.
B. title “桌面模式”, small badge “自定义”, small highlighted label “默认入口”, command “.venv/Scripts/python.exe desktop.py”, a modest outlined “启动” button.
These commands fit the Python application; do not invent npm commands for Tracelight.
The primary global header “启动” action corresponds to the default entry.
Only the header's main launch is solid cobalt; individual secondary entry buttons are restrained.
Do not show full runtime logs in the overview; those belong under “启动与运行”.

7. At the bottom of main content, a shallow full-width “项目简介” panel.
Heading “项目简介”; small right link “阅读全文 ›”.
A short rendered README preview:
“Tracelight”
“把散落在磁盘各处的开发项目收进统一索引，数据保存在本机。”
“支持快速启动、Git 记录与开发笔记。”
Show this as clean reading content, with no huge heading or duplicate path/status/data tiles.
It links conceptually to the full README under “项目资料”.
This bottom panel must remain visible in the full-screen preview.

8. A very quiet footer line “数据保存在本机” and “设计示意 · 演示数据”.

Important design priorities:
- Strong resemblance to a coherent working productivity app, with the same blue/white identity as the revised homepage.
- Compact identity header, only one primary action, four clear local navigation destinations.
- Overview immediately answers: what project is this, what happened recently, what did I write, and how do I resume it.
- Wide content with NO permanently occupied file-tree column, no empty fake drawer placeholder, no unrelated right rail.
- Preserve the project-tab strip and status/launch/editor/folder/copy affordances.
- Project-specific blue identity is consistent in the TL monogram and contribution bars.
- Do not add new technical capabilities, gamification, charts for charts' sake, or implementation explanations in the product UI.
- All text should be properly spelled, sharp and readable Simplified Chinese; all named buttons should look usable and align precisely.
- Beautiful but restrained, with practical information density, generous paragraph width, and a complete visible screen.
```
