# Homepage redesign v1 — imagegen prompt

生成方式：内置 `image_gen.imagegen`。新生成单张静态界面图，无图片输入。设计稿为演示数据，不代表已经实现的界面。

```text
Use case: ui-mockup
Asset type: a high fidelity, implementation-ready desktop application homepage mockup for the existing Chinese local developer project archive named “归迹拾光 / Tracelight”.
Primary request: generate ONE beautiful but practical revised homepage that adds last-opened timestamps to project cards, adds a collapsible category navigation sidebar, and replaces an annual GitHub square heatmap with a compact, useful recent-project activity panel. This is an actual working software screen, not a marketing landing page or presentation slide.

Output framing: one flat front-on full-screen desktop app interface, landscape approximately 1800 x 1180, high resolution, crisp readable typography and very accurate Simplified Chinese. Fill the entire canvas with the application screen. No laptop or monitor frame, no perspective, no surrounding scenery, no annotations, no arrows, no watermark. All interface text must be real, readable, correctly spelled Chinese or the English names specified below.

Design direction: a calm, polished local Windows productivity application. Preserve Tracelight's existing visual identity: pale cool gray #F6F7F9 canvas, white panels, cobalt #0969DA accents, deep charcoal text, muted slate secondary text, thin cool-gray borders, subtle 10-12px radii and restrained shadows. Spacious and well aligned yet information-rich. Use professional clean sans-serif Chinese typography, with English project names in a matching sans-serif and paths in a small monospace. Tiny coherent outline icons, no decorative emoji. Sidebar and main content are light, not dark. No gradients, no glass effects, no illustration, no oversized empty hero, no generic KPI cards dominating the page, no ring charts or star maps.

Exact hierarchy and layout:
1. Across the very top, preserve the existing slim open-project tab strip, about 36px tall. Tabs “首页” selected, then “Tracelight”, “WindowAnchor”, “SkillManager”; a small tab dropdown on far right.
2. Under that, a 68px white global header. Left: small blue folder/code symbol with Chinese brand “归迹拾光” and smaller “Tracelight”. Next to it a very subtle caption “本机索引库 · 数据不出本机”. Right: outlined “批量扫描导入” button, cobalt filled “＋ 手动录入” button, “工具” dropdown, settings and appearance icons.
3. Below the header, an approximately 208px wide white sidebar separated by a thin vertical border. Add a small collapse icon at its upper right. Section heading “快捷导航”. Active “全部项目” with blue tinted background, a blue icon and right count 18. Below “最近打开” count 9 with clock icon, “已置顶” count 3 with pin icon. Next section heading “项目分类”. Six rows of dynamic category names, subtle colored markers and right counts: “前端” 6, “后端” 4, “桌面应用” 4, “AI / 研究” 2, “工具脚本” 1, “未分类” 1. At bottom of sidebar, a green dot and “本地运行中”, small understated settings item. Make the row spacing comfortable but compact.
4. Main content begins to the right of sidebar, with 32px outer margins. At top show “项目总览” in dark moderately large bold text, a short secondary line “找到项目，接着上次的思路。” and right-aligned small date “2026年10月22日”. Immediately below show ONE slim horizontal statistics row, not five oversized cards: “18 全部项目”, “12 活跃”, “6 已归档”, “0 已废弃”, “0 路径丢失”, separated subtly. These are demo values.
5. The new key feature: one white compact panel about 210px tall, titled “本周拾光”, with very small subtitle “近 7 天 · 仅本人” and right-side link “查看明细 ›” plus collapse chevron. This completely REPLACES the old square calendar heatmap.
Inside this panel use three balanced horizontal zones separated by subtle space:
- left 22%: dominant “32” with small “次提交”; below “5 个项目 · 4 个活跃日”, short small label “最近的开发足迹”.
- middle 43%: miniature 7-day bar chart titled “每日节奏”, with seven clean cobalt rounded vertical bars along a fine baseline, the first, fourth and last zero-height bars represented by a tiny horizontal baseline tick. Date labels “10/16”, “10/17”, “10/18”, “10/19”, “10/20”, “10/21”, “今天”. Values are respectively 0, 6, 8, 0, 10, 8, 0; display small numbers on nonzero bars if legible. Today has a thin blue pill or ring around its label. This is a BAR CHART, not a grid of squares.
- right 35%: heading “最近推进”, 3 tidy project rows with a tiny color dot, name, restrained horizontal contribution bar and number: “Tracelight” 18, “WindowAnchor” 9, “SkillManager” 3; a small last line “其他 2 个项目 · 2 次”. These sum to 32. This encodes commit distribution, never time spent or an efficiency score.
Keep this panel low enough that multiple project cards are visible in the first screen. Use visual clarity, not ornamental graphics.
6. Under the panel, one compact filter toolbar: a wide search input with magnifying glass, placeholder “搜索名称 / 别名 / 路径 / 标签…” and small “/” key hint. Then dropdowns “全部状态”, “全部标签”, “最近打开”, and on the right “共 18 个项目” with grid/list toggle. Do not duplicate the category dropdown because the left sidebar handles categories. A subtle small helper line below says “拖动卡片调整顺序，自动保存”.
7. Section header “进行中” with blue dot and count “6” and a fine extending horizontal divider. Below show SIX complete project cards in a clean three-column by two-row grid. Card content must be spacious enough to scan but not excessively tall. Each card has:
- top: a small colored project symbol, bold English name, a tiny blue outlined status “进行中”, and discreet drag handle / pin icons; first three cards are pinned with recognizable small cobalt pins.
- short Chinese one-line description.
- path line in muted small monospace, with compact open-folder, editor, copy icons to the right.
- category chip and 2–3 restrained technology chips.
- bottom separated by a thin divider: a clearly visible clock icon and “上次打开：…” in medium gray; this new timestamp must be a separate labeled line, not a cryptic unlabeled relative time. Put smaller “修改于…” at bottom right to keep the existing modification meaning separate.
Project cards, left to right, first row then second:
A. “Tracelight”; description “本地项目归档与快速启动”; path “D:/Projects/Tracelight”; category “桌面应用”; chips “Python”, “Vue”, “FastAPI”; new timestamp EXACTLY “上次打开：今天”; modification “修改于 2 小时前”.
B. “WindowAnchor”; description “保存窗口位置，找回工作现场”; path “D:/Projects/WindowAnchor”; category “桌面应用”; chips “C#”, “.NET”; new timestamp EXACTLY “上次打开：昨天”; modification “修改于 1 天前”.
C. “SkillManager”; description “统一管理你的 AI 技能”; path “D:/Projects/SkillManager”; category “桌面应用”; chips “Rust”, “Tauri”, “Vue”; new timestamp EXACTLY “上次打开：7 天前”; modification “修改于 2 天前”.
D. “SuKe”; description “应用与窗口布局恢复工具”; path “D:/Projects/SuKe”; category “桌面应用”; chips “C#”, “.NET”; new timestamp “上次打开：3 天前”; modification “修改于 3 天前”.
E. “NextPaste”; description “剪贴板历史与快捷粘贴”; path “D:/Projects/NextPaste”; category “前端”; chips “Go”, “Wails”, “Vue”; new timestamp “上次打开：30 天前”; modification “修改于 5 天前”.
F. “LinuxDo Search”; description “社区话题的本地搜索”; path “D:/Projects/LinuxDoSearch”; category “AI / 研究”; chips “Python”, “SQLite”; new timestamp “尚无打开记录”; modification “修改于 7 天前”.
8. At lower edge, subtle footer “数据保存在本机” and “设计示意 · 演示数据”.

Essential quality constraints: first impression should be a trustworthy practical Chinese developer tool, with the three requested changes immediately legible. Preserve all named existing actions and project tab strip. Readable Chinese. Avoid invented navigation products, cloud sync, account avatars, productivity scores, gamification, confetti, huge hero text, or calendar squares. Keep clocks visibly labeled, navigation clear, project grid primary. Show the WHOLE interface and complete bottom card rows without cropping.
```
