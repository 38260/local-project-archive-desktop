# Homepage redesign v2 — imagegen prompt

生成方式：内置 `image_gen.imagegen`。以 `homepage-redesign-v1.png` 为编辑目标，保留原图，生成独立的第二版设计预览。图片中的数据为演示数据，功能尚未实现。

```text
Use case: ui-mockup / precise-object-edit
Asset type: revision 2 of the Tracelight Chinese desktop homepage design preview.
Input image 1: EDIT TARGET and exact visual/layout reference, the existing light-theme homepage mockup. Preserve its polished Chinese typography, thin gray borders, cobalt actions, white cards, pale gray canvas, front-on view, complete 3-column x 2-row project grid, top tabs, global header, proportions, compact activity panel, and overall visual identity.

Primary request: update this exact homepage mockup to reflect the user's clarified navigation and visit-time behavior. Produce ONE complete, crisp, high-fidelity landscape desktop app screen, approximately the same aspect ratio as the input. Do not introduce a new style. Keep all six cards fully visible. No device frame, perspective, annotations, illustration, watermark, or explanatory overlays. All Chinese must be legible.

Required changes:
1. REPLACE the old fixed project-category sidebar section (前端 / 后端 / 桌面应用 / AI / 研究 / 工具脚本 / 未分类) with TWO independently configurable navigation sections that coexist.
Keep the upper “快捷导航” section: selected “全部项目” 18, “最近打开” 9, “已置顶” 3.
Next section: “项目状态”, with a small understated “模板⌄” control at its heading's right to indicate selectable navigation templates. Display existing project statuses, each with a recognizable small status icon, a label and aligned count:
“进行中” 6 (blue dot), “暂停” 2 (amber pause icon), “已完成” 4 (green check), “归档” 6 (gray archive box), “废弃” 0 (gray trash icon).
Next section: “常用标签”, with a small plus button at heading's right. Show user-selected tag shortcut rows: “Python” 5, “Vue” 6, “C#” 4, “Rust” 2, “Go” 2, each using a small hash icon and modest neutral text. These counts overlap across projects and are not supposed to sum to 18.
At the bottom of these sections, a modest text button “管理导航” with a sliders icon, so the ability to configure the sidebar is visible.
Keep green “本地运行中” in the bottom sidebar footer.
Sidebar should be about the same width as before; make rows compact enough to fit all three groups without cropping. The state section and tag section must both be visibly present. Do NOT replace one with a tab that hides the other. Do NOT keep the old fixed frontend/backend category list.

2. Make “每日节奏” and “最近推进” use EXACTLY THE SAME color per project.
The small 7-day chart must be a true STACKED vertical bar chart with a clearly visible common baseline, not solid blue bars and not calendar squares.
Assign stable colors:
Tracelight = blue #2F81F7
WindowAnchor = green #22A66A
SkillManager = purple #9061F9
Other projects = slate gray #A0A9B8
Use these SAME colors for each project's dot AND its horizontal contribution bar under “最近推进”.
Keep the activity title “本周拾光” and subtitle “近 7 天 · 仅本人”, total “32 次提交”, secondary “5 个项目 · 4 个活跃日”, and link “查看明细 ›”.
Dates and exact per-day stacked values, bottom to top in order blue / green / purple / gray:
10/16: 0 / 0 / 0 / 0 => total 0, baseline tick only.
10/17: 4 / 2 / 0 / 0 => total 6.
10/18: 5 / 1 / 2 / 0 => total 8.
10/19: 0 / 0 / 0 / 0 => total 0, baseline tick only.
10/20: 6 / 3 / 0 / 1 => total 10.
10/21: 3 / 3 / 1 / 1 => total 8.
今天: 0 / 0 / 0 / 0 => total 0, baseline tick only and today's outlined pill label.
Place a small clear total label on each nonzero bar: 6, 8, 10, 8.
The right-side rows must read “Tracelight” 18 in BLUE, “WindowAnchor” 9 in GREEN, “SkillManager” 3 in PURPLE; a gray dot and small “其他 2 个项目 · 2 次” line underneath.
Do not color all right-side bars blue; the one-to-one color relationship between chart segments and project list is a key requirement. No productivity score or time-spent claims.

3. LAST OPENED TIMESTAMP: keep a separate clock-labeled line at the bottom of each project card, with a different smaller modification-time label at right. The defined interaction is that clicking a project card and successfully entering its detail page records “last opened”. Do not insert implementation text in the UI. Preserve exactly these demo values:
Tracelight: “上次打开：今天”; “修改于 2 小时前”
WindowAnchor: “上次打开：昨天”; “修改于 1 天前”
SkillManager: “上次打开：7 天前”; “修改于 2 天前”
SuKe: “上次打开：3 天前”; “修改于 3 天前”
NextPaste: “上次打开：30 天前”; “修改于 5 天前”
LinuxDo Search: “尚无打开记录”; “修改于 7 天前”

4. PROJECT LOGO CONCEPT: use consistent, attractive small rounded-square default MONOGRAM badges, showing how projects without custom-uploaded logos would look. Use “TL” for Tracelight in blue, “WA” for WindowAnchor in green, “SM” for SkillManager in purple, “S” for SuKe in slate, “N” for NextPaste in amber, “L” for LinuxDo Search in teal. All six badges must be the same size and visual style. No fabricated official logos and no Windows or document-app brand logos. Custom image replacement is a possible future user option; do not add a settings modal or upload widget to the homepage.

5. FILTER TOOLBAR: because status and common tags now have sidebar shortcuts, simplify the row above cards to a wide search input “搜索名称 / 别名 / 路径 / 标签…” with a “/” keyboard hint, a modest “最近打开⌄” sorting dropdown, and right text “共 18 个项目”. Remove the grid/list toggle, because no new list-view feature is being designed. Keep the small helper “拖动卡片调整顺序，自动保存”.

Keep these reference screen details:
- Top open-project tab strip “首页”, “Tracelight”, “WindowAnchor”, “SkillManager”.
- Brand “归迹拾光”, small English “Tracelight”, small caption “本机索引库 · 数据不出本机”.
- Header actions “批量扫描导入”, “＋ 手动录入”, “工具”, settings and theme icons.
- Page title “项目总览”; short secondary text “找到项目，接着上次的思路。”; date “2026年10月22日”.
- Compact summary 18 全部项目 / 12 活跃 / 6 已归档 / 0 已废弃 / 0 路径丢失. Status count sum 6 + 2 + 4 + 6 + 0 = 18; active 6 + 2 + 4 = 12.
- Card group header “进行中” count 6. Keep the first three pins blue and other pins neutral, all drag handles and folder/editor/copy action icons.
- Keep the same six project names, short Chinese descriptions, paths D:/Projects/..., category and technology chips, and their positions in a three-column by two-row grid.
- Small bottom footer “数据保存在本机” and “设计示意 · 演示数据”.

Critical acceptance: simultaneous STATUS + CUSTOM TAG navigation, obvious matching multicolor STACKED daily chart and project list, six legible last-opened timestamps, consistent default letter logos, no old fixed project-category sidebar, no grid/list toggle. Retain the practical dense-but-calm layout of the reference with fully visible bottom cards.
```
