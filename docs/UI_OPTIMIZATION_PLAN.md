# 本地项目档案 · UI 优化方案

> 评审对象：`app/static/`（dashboard.html / project.html / css/style.css / js/*.js）
> 评审时间：2026-08-30 · 当前库内 6 个项目（进行中 2 / 已完成 2 / 暂停 1 / 归档 1，丢失 0）
> 说明：本文只做现状诊断与改造方案，不含代码改动。所有行号对应评审时的文件版本。

---

## 0. 结论摘要

整体完成度其实不低：亮暗双主题、8px 栅格、玻璃顶栏、Conventional Commits 分色、提交热力图、
目录树扩展名着色、自定义下拉的键盘可达性，这些都属于"超出同类本地工具平均水平"的部分。
真正的问题不在"好不好看"，而在三处：

| 级别 | 问题 | 影响 |
|---|---|---|
| 🔴 严重 | 首页卡片完全不可键盘访问；`dep-stats` 区块 DOM 结构错位 | 键盘用户进不了详情页；依赖统计脱离卡片渲染成孤立灰条 |
| 🟠 明显 | 行内操作 hover 才可见、顶栏窄屏溢出、批量重解析串行 N 请求 | 触屏不可达；中屏按钮挤压；50 个项目要打 50 次接口 |
| 🟡 累积 | 状态色重复定义 4 处、硬编码色散落、字号/圆角无收敛、约 12 处死代码 | 每改一次配色要动 4 个地方，样式表持续膨胀 |

建议按 §5 的四批推进：**前两批（约 2 天）解决 80% 的可感知问题**，第三批是设计系统还债，
第四批视项目规模增长再决定。

---

## 0.1 实施状态（2026-08-30 已落地）

本文档的 **P0 全部 6 项、P1 全部 11 项、P2 全部 5 项** 已实施完成，
另完成 P3 中 3 项低成本项。改动集中在 `app/static/` 六个文件，后端未改动。

| 批次 | 状态 | 备注 |
|---|---|---|
| P0 缺陷（6 项） | ✅ 全部完成 | 含 `dep-stats` 结构错位、卡片键盘可达性 |
| P1 体验（11 项） | ✅ 全部完成 | |
| P2 设计系统（5 项） | ✅ 全部完成 | P2-3 为**保守收敛**：只消除字号半档 + 圆角归 4 档 + 间距 token 化，未逐处重排间距 |
| P3 规模化（6 项） | 🟡 完成 3 项 | 已做：主题三态、详情页上下项、打印样式 |

**P3 中主动跳过（等规模到了再做，详见 §5 触发条件）**：
列表接口裁剪与分页、批量操作、置顶/收藏与最近访问、卡片快捷改状态、全局快捷键面板、截图排序与重命名。
理由：当前库内 6 个项目，这几项的收益为零，但会引入新的交互复杂度和后端改动。

### 实施过程中新发现并修复的问题（原文档未列出）

1. **`shortPath` 吃掉绝对路径的前导分隔符** —— `split(/[\\/]/).filter(Boolean)` 会丢掉开头的 `/`，
   `/home/user/…` 会渲染成 `home/user/…`。已改为用 `/^[\\/]+/` 保留前导（含 UNC 的双反斜杠）。
   这个问题是补单元测试时暴露的，肉眼审查看不出来。
2. **Markdown 工具栏的 `▤` 漏改** —— 图标替换时只处理了 emoji，漏了这个几何符号，已换成 `code` 图标。

### 验收结果

- 无头 Chrome 渲染首页 + 详情页：**0 个 JS 运行时错误**，Vue 正常挂载，无残留插值。
- 详情页 `<section>` 开闭标签 **11 / 11 配平**（原为 10 开 / 11 闭）。
- 新增辅助函数单元测试 **30 项全通过**（`shortPath` / `relTime` / 主题三态 / 既有行为回归）。
- 项目自带后端冒烟测试 **56 通过 / 0 失败**（后端未改动，确认无回归）。

---

## 1. 现状评估

### 1.1 做得好的（建议保留，不要重构掉）

- **自定义下拉 `LpaSelect`**：原生 `<select>` 在暗色下样式不可控，这里自己实现了
  `role="listbox"` + 方向键导航 + Esc 关闭 + 点击外部收起，键盘可达性完备。这是全站质量最高的组件。
- **`:focus-visible` 处理**：`:focus { outline: none }` 配 `:focus-visible` 环，
  鼠标点击不显环、Tab 导航显环，是正确做法。
- **`prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast`**：
  三个媒体查询都覆盖了，国内工具类项目很少做到这个程度。
- **详情页 TOC 滚动联动的 `spySuspendedUntil` 机制**：点击锚点后锁高亮 1 秒再交还监听，
  规避了"页面触底时高亮跳回上一个面板"的经典 scroll-spy 缺陷。
- **目录树默认展开两层 + 文件点击复制相对路径**：贴合真实使用场景。
- **热力图按周一对齐、用本地年月日构造 Date**：避开了 `toISOString()` 的时区偏移坑。

### 1.2 待改进的（详见 §2–§4）

诊断结论按"缺陷 / 体验 / 设计系统 / 规模化"四类展开，共 30 项。

---

## 2. 🔴 P0 缺陷（必修，成本极低）

### P0-1 `dep-stats` 区块 DOM 结构错位

`project.html` 第 224 行的 `</section>` 提前关闭了 `sec-stats` 面板，
226–234 行的依赖统计块被挤到了 `.panel` 外面，235 行还多出一个孤立 `</section>`。

```text
191  <section class="panel" id="sec-stats">      ← 开
       ...
223    </template>
224  </section>                                  ← 提前关闭（应移到 235 行之后）
225
226    <div class="dep-stats" v-if="depStats.total">   ← 掉到 panel 外，裸 div
        ...
234    </div>
235  </section>                                  ← 无匹配开标签，浏览器直接丢弃
```

**实际观感**：依赖统计条没有白底卡片、没有圆角、没有内边距约束，
像一条凭空浮在两个白卡之间的灰条，且底部间距与相邻面板不一致。

**修复**：把 226–234 行整块移到 224 行之前（即 `</template>` 之后、`</section>` 之前），删除 235 行多余闭合标签。

> 顺带一提：这个块也没有进左侧 TOC 的 `sections` 列表，所以即使修好结构，
> 用户也无法从目录直接跳到它。建议一并作为 `sec-stats` 面板的一部分，不单独设锚点。

### P0-2 首页卡片完全不可键盘访问

`dashboard.html:69-72`，整张卡片是一个带 `@click` 的 `<div>`，没有 `role`、`tabindex`、也没有键盘事件：

```html
<div v-for="p in g.items" class="card" :data-status="p.status" @click="goto(p)">
```

**后果**：整个首页对纯键盘用户是死锁——Tab 只能走到顶栏按钮和搜索框，无法进入任何项目详情。
这是全站最严重的可达性缺陷，也是 WCAG 2.1.1 的直接违规。

**修复（推荐方案）**：把卡片标题升级为真链接，卡片本体加 `role="link"` + `tabindex="0"` + `@keydown.enter`：

```html
<div class="card" role="link" tabindex="0" @click="goto(p)" @keydown.enter.prevent="goto(p)">
  <h3><a :href="'/project/' + p.id" @click.stop>{{ p.name }}</a></h3>
```

额外收益：`h3 > a` 天然支持 Ctrl+点击在新标签页打开（当前只能原地跳转），语义也更正确。

### P0-3 行内操作按钮 hover 才可见

`style.css:374`：

```css
.card .path-row .row-actions { opacity: 0; transition: opacity .15s; }
.card:hover .path-row .row-actions { opacity: 1; }
```

同一问题的两个面：
- **触屏设备没有 hover**，三个按钮（资源管理器 / VSCode / 复制路径）永久不可见；
- 键盘用户 Tab 到这些按钮时，若卡片没被 hover，`opacity:0` 的元素仍可聚焦但完全看不见——比不可用更糟。

**修复**：

```css
.card .path-row .row-actions { opacity: .45; transition: opacity .15s; }
.card:hover .path-row .row-actions,
.card:focus-within .path-row .row-actions { opacity: 1; }
@media (hover: none) { .card .path-row .row-actions { opacity: 1; } }
```

### P0-4 顶栏窄屏溢出

`.topbar` 是 `display:flex` 但 **没有 `flex-wrap`**，`.logo` 又带 `white-space:nowrap`，
右侧挤了 5 个按钮（批量扫描 / 全部重新解析 / 手动录入 / 导出 JSON / 主题切换）。
在 768–1100px 区间会出现横向挤压甚至溢出，窄于 768px 则必然横向滚动。

**修复**：加 `flex-wrap: wrap`；`< 900px` 时 `.logo .dim` 隐藏（`.dim` 只是副标题，信息价值低），
按钮文案降级为图标 + `aria-label`。

### P0-5 「全部重新解析」串行打 N 次接口

`dashboard.js:100-121` 用 `for` 循环逐个 `POST /api/projects/{id}/rescan`。
而后端 `app/routers/projects.py:274` **已经实现了 `POST /api/projects/rescan-all`**（含线程池并发解析），
前端却完全没用上。6 个项目时无感，50 个项目就是 50 次串行往返 + 50 次 toast 风暴。

**修复**：改为调用 `/api/projects/rescan-all`，弹窗内展示整体进度条（当前按钮上的
`解析中 3/50` 文字计数器可保留，但应由后端进度事件驱动而非前端累加）。

### P0-6 死代码清理

已确认未被任何模板/样式引用的残留（列出来是因为它们会持续误导后续维护者）：

| 位置 | 残留 | 说明 |
|---|---|---|
| `project.js:61,462` | `descTab` | 只被赋值，从不被读取（预览已改为实时双栏） |
| `project.js:62,224,...` | `descHtml` | 只被赋值，模板用的是 `descLive` |
| `project.js:461` | `previewDesc()` | 定义后从未调用（废弃的"预览"标签页遗留） |
| `project.js:587` | `copyRel()` | 定义后从未调用（TreeNode 内部直接用 `copyText(fileRel)`） |
| `project.js:65` | `rescanning` | 只被 `data()` 声明，模板无引用 → 重新解析时按钮无 loading 态 |
| `project.js:89` | `uploadingShots` | 有 true/false 赋值，但模板没读 → 上传大图时零反馈 |
| `style.css:627` | `.md-tabs` | 无对应 HTML |
| `style.css:292-298` | `.chip` / `.chip.on` | 无对应 HTML（在用的是 `.chip-value` / `.chip-soft`） |
| `style.css:929-930` | `.more-divider` / `.gap-left` | 无对应 HTML |
| `style.css:440-446` | `.detail-head` / `.alias-lg` | `.detail-head` 已被 `.proj-card` 取代 |
| 后端 `_row_to_dict` | `stack_summary`、`exists_now` | 接口返回但前端从未消费 |

> `uploadingShots` 和 `rescanning` 属于**"状态已声明但忘了接线"**，清理时建议顺手补上 loading 反馈（见 P1-8），
> 而不是简单删掉。

---

## 3. 🟠 P1 体验瓶颈（高性价比）

### P1-1 统计卡可点击下钻

首页四张统计卡（全部 / 活跃 / 已归档 / 路径丢失）只是数字展示，不可点击。
"看得见摸不着"是仪表盘的典型浪费——用户看到"3 个路径丢失"后的第一反应就是点它。

```text
现状                              建议
┌──────────┐                     ┌──────────┐
│    6     │  ← 纯展示           │    6     │  ← <button>，点击 = 清除筛选
│ 全部项目 │                     │ 全部项目 │
└──────────┘                     └──────────┘
                                      │ click
                                      ▼
                                 q="" / statusFilter="" / tagFilter=""
                                 showArchived = (点击的是"已归档"卡)
```

**实现**：给 `.stat` 换成 `<button class="stat">`，点击后设置对应筛选并 `scrollTo(0)`。
"路径丢失"没有现成筛选维度，需新增 `lostOnly` 布尔（前端即可完成，无需改后端）。

### P1-2 筛选维度补齐

当前筛选栏只有：搜索框 + 状态 + 标签 + 显示归档复选框。缺三个高频维度：

| 缺失 | 说明 | 成本 |
|---|---|---|
| **分类筛选** | `category` 数据已有、`allCategories` 计算属性已存在且用在了录入表单的 datalist，但筛选栏没用 | 前端，极低 |
| **排序切换** | 后端 `list_projects` 硬编码"状态优先级 + updated_at DESC"，前端无法改 | 前端（对已加载数据重排），低 |
| **丢失项目** | 见 P1-1 | 前端，低 |

建议筛选栏右侧加一个排序下拉：`最近修改 / 最近访问 / 名称 / 创建时间 / 状态`。

### P1-3 空结果态加"清除筛选"

`dashboard.html:121` 的筛选无结果只有一行 `<template v-else>没有符合筛选条件的项目。</template>`。
用户必须自己找到是哪个筛选条件生效了。

**修复**：文案改为「没有符合筛选条件的项目」+ 一个「清除全部筛选」按钮，并在按钮旁
用 chip 列出当前生效的条件（`状态：暂停 ✕` `标签：Python ✕`）。

### P1-4 卡片信息层级重排 + 路径截断方式修正

当前卡片纵向堆了 5 行：标题 / 路径 / intro / last commit / 分类+时间 / 标签。
其中 `intro` 和 `last commit` 都是单行 ellipsis，视觉权重却和路径一样重，主次不分。

另外 `style.css:373` 的路径截断用了 `direction: rtl`：

```css
.card .path-row .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
```

`direction: rtl` 的意图是"保留路径尾部（更有区分度的目录名）"，但它会**重排行内标点与括号的位置**——
Windows 路径 `D:\code\my-project` 中的反斜杠与后续符号在 RTL 下会被 BiDi 算法重新排序，
遇到含括号、中文或数字的路径时渲染结果不可预测。

**建议改造后的卡片结构**：

```text
┌─────────────────────────────────────────┐
│ ● My Project          [别名]   [进行中]  │  ← 主行：18px/700，别名琥珀chip
│ 📁 D:\code\my-project          📂 ⌨ ⧉  │  ← 次行：13px mono，ltr + 中部省略
│ feat: 新增导出功能              a3f9c21 │  ← 弱化行：13px muted，commit type 徽章
│ 🗂 Web 工具                 修改 08-28  │  ← 元信息行：分类 + 相对时间
│ Python  FastAPI  SQLite                │  ← 标签行：语义分色
└─────────────────────────────────────────┘
```

- `intro` 与 `last_commit` 合并为一行（intro 有则显示 intro，否则显示 last commit），减少一行；
- 路径改用 `direction: ltr` + CSS 中部省略（`-webkit-line-clamp` 不适用单行，
  可用 `text-overflow: ellipsis` + `direction: ltr`，或 JS 截断保留首尾 `D:\code\…\project`）；
- 相对时间（`3 天前`）比绝对时间（`2026-08-28 14:20`）扫读效率高，绝对时间保留在 `title` 里。

### P1-5 详情页 TOC 窄屏降级

`style.css:723`：`.toc-nav { display: none }`（≤1024px）直接把左侧目录整个移除。
详情页有 **11 个面板**，长页面失去导航等于让用户盲滚。

**建议**：≤1024px 时改为顶部横向滚动 chip 条（sticky 在顶栏下方）：

```text
≤1024px 建议布局
┌────────────────────────────────────────────┐
│ [📁 顶栏]                                   │
├────────────────────────────────────────────┤
│ 基础信息 Git信息 构建配置 文件统计 描述 ▸  │  ← 横向滚动，当前项高亮并自动滚入视口
├────────────────────────────────────────────┤
│ [项目名片]                                  │
│ [基础信息面板]                              │
│ ...                                         │
└────────────────────────────────────────────┘
```

复用 `.toc-nav a` 的样式，只改 `flex-direction: row` + `overflow-x: auto` + `scroll-snap`。

### P1-6 详情页面板骨架屏

`project.js:227-232` 在 `mounted` 里并发发起 6 个请求（readme / tree / notes / changelogs / commits / screenshots），
各面板独立 pop-in。其中 commits 面板体积最大（时间线 + 月度柱状图），
它加载完成时整页会**向下猛推**——如果用户正在读 README，视线会被弹走（CLS）。

**建议**：给 `#sec-commits`、`#sec-readme`、`#sec-stats` 三个体积不稳定的面板加骨架占位
（等高灰块，与真实内容高度接近），其余小面板保持现状。

### P1-7 未保存草稿保护

描述编辑器（`.md-editor`，`v-model="p.description"`）和笔记编辑器都是无保护的：
写到一半误触返回、刷新或关闭标签页，内容直接丢失。这是本地笔记类工具最容易挨骂的点。

**建议**（纯前端，无需改后端）：
1. `description` / `noteDraft` / `logDraft` 变更时打 dirty 标记；
2. `beforeunload` 在 dirty 时弹浏览器原生确认；
3. dirty 内容同步写 `localStorage`（key 带 `projectId`），
   重新进入时检测到草稿则提示「发现未保存的草稿，是否恢复？」。

### P1-8 上传 / 重解析的加载反馈

`uploadingShots`（P0-6）已声明未接线。截图上传（拖拽或点选）在大图/多图时可能持续数秒，
期间界面完全无变化，用户会以为拖拽失败而重复操作。

**建议**：上传中在 `.shots-empty` 或 `.shot-grid` 上覆盖一个半透明进度层；
`rescanning` 同理，接到「🔄 重新解析」按钮的 `:disabled` 上。

### P1-9 模态框可达性与行为补全

当前 `.modal-mask` 是一个裸 `<div>`，缺 `role="dialog"`、`aria-modal="true"`、
focus trap 和 body 滚动锁定。具体表现：

- 打开录入弹窗后，**背后的页面仍可滚动**；
- Tab 键会跑出弹窗外，聚焦到被遮住的页面元素；
- 打开时焦点不自动落到第一个输入框（`openAdd()` 里手动 focus 了 path 输入框，但编辑档案弹窗没有）。

**建议**：抽一个 `useModal()` 组合式逻辑或简单的全局函数，统一处理
`role` / `aria-modal` / `body.overflow=hidden` / 打开时聚焦首个可聚焦元素 / Tab 循环 / 关闭时焦点归还触发元素。
三个弹窗（录入 / 扫描 / 编辑档案）共用。

### P1-10 提交记录加载更多与筛选

`GET /api/projects/{id}/commits?limit=50`（后端支持 1–200）。前端固定 50 条，
没有"加载更多"，也没有按作者/类型过滤。对提交历史长的项目不够用。

**建议**：底部加「加载更早提交」按钮（`limit` 递增或游标分页）；
面板头部加提交类型筛选 chip（复用 `commitType()` 与 `.ct-*` 配色，已有现成分色体系）。

### P1-11 Toast 退出动画与去重

`common.js:38-39` 创建 toast 后 `setTimeout(() => el.remove(), ...)`——**只有入场动画，移除是瞬时的**，
视觉上会"啪"地消失。且无堆叠上限，批量导入 20 个项目时若逐个失败会刷满整屏。

**建议**：
1. 加 `.toast-leave-active` 过渡（opacity + translateX），先播动画再 remove；
2. 最多同时显示 4 条，超出移除最旧；
3. 相同文案的 toast 在 1.5s 内合并计数（`已保存 3 条笔记`）而非堆叠 3 条。

---

## 4. 🟡 P2 设计系统治理（技术债）

这一批不影响功能，但决定"再改 10 个页面要花多久"。

### P2-1 状态色重复定义 4 处

同一个"进行中=蓝 / 已完成=绿 / 暂停=橙 / 归档=灰"的映射，在 4 个地方各写了一遍：

| 位置 | 选择器 |
|---|---|
| `style.css:211-214` | `.badge.s-进行中` / `.s-已完成` / `.s-暂停` / `.s-归档废弃` |
| `style.css:343-346` | `.card[data-status="进行中"]::before` 等 |
| `style.css:312-315` | `.status-group[data-status="进行中"] .g-dot` 等 |
| `style.css:171-173` | `.lsel.accent.sv-已完成` 等（且**漏了"进行中"**） |

改一次状态色要动 4 个地方，漏改就是视觉不一致（现在"进行中"在下拉里就没有状态色）。

**建议**：定义单一真源变量，各选择器只引用：

```css
:root {
  --st-doing: var(--accent);
  --st-done:  var(--ok);
  --st-hold:  var(--warn);
  --st-arch:  var(--muted);
}
[data-status="进行中"], .s-进行中, .sv-进行中 { --st: var(--st-doing); }
/* 各选择器统一用 var(--st) */
```

### P2-2 语义色 token 化

硬编码色值与 CSS 变量混用，暗色主题靠逐条 `[data-theme="dark"]` 覆盖（目前 8 条覆盖规则）：

```
rgba(245,158,11,.16) / #b45309      → 别名琥珀
rgba(244,63,94,.10)  / #be123c      → 分类玫红
rgba(13,148,136,.14) / #0f766e      → 语言青绿
rgba(124,58,237,.13) / #7c3aed      → 框架紫
rgba(47,129,247,...)                → 热力图（写死，与 --accent 脱钩）
```

**建议**：抽 `--c-amber-bg / --c-amber-fg`、`--c-teal-bg / --c-teal-fg` 等成对 token，
暗色覆盖从"逐条改颜色"变成"只改一组变量值"。热力图 l1–l4 改用
`color-mix(in srgb, var(--accent) 35%/60%/85%/100%, transparent)`，换主题色时自动跟随。

### P2-3 间距 / 圆角 / 字号收敛

当前使用的取值（实测统计）：

| 维度 | 现状取值 | 建议收敛为 |
|---|---|---|
| 间距 | 8 / 10 / 12 / 14 / 16 / 18 / 22 / 24 / 26 / 28 | 4 / 8 / 12 / 16 / 24 / 32（4pt 网格） |
| 圆角 | 4 / 6 / 7 / 8 / 10 / 12 / 14 / 16 | 4 / 8 / 12 / 16（4 档） |
| 字号 | 13 / 13.5 / 14 / 14.5 / 15 / 15.5 / 17 / 18 / 20 / 26 / 28 | 12 / 13 / 14 / 16 / 18 / 22 / 28（7 档） |

13.5 / 14.5 / 15.5 这类半档字号在缩放和跨浏览器渲染时容易对齐错位，建议优先消掉。

### P2-4 图标体系统一

当前混用两套：
- **Emoji**：📁 📂 ⌨ ⧉ 🗂 🔄 ✏ 🗑 ⬇ ⬆ 💾 ᯤ ◈ ▣ ▤ ⑂
- **内联 SVG**：`.stat .stat-ico`（Lucide 风格线性图标）

问题有三个：① Emoji 在 Windows / macOS / Linux 上字形差异极大（🗂 在部分 Windows 版本显示为方框）；
② ⌨ ⧉ ▤ ◈ ▣ ⑂ 这类几何符号语义模糊，用户需要靠 `title` 猜；
③ Emoji 自带颜色，在暗色主题下无法随 `--text` 变色。

**建议**：统一为一套线性 SVG 图标（20px，`stroke-width: 1.5`，`currentColor`），
抽成 `<lpa-icon name="folder" />` 组件或 SVG sprite。stat-ico 现有 4 个图标可直接作为起点。

### P2-5 `prefers-reduced-motion` 下的脉冲动画

`style.css:83-86` 用全局 `animation-duration: .01ms !important` 关闭动画。
但 `.stat.stat-lost.pulse` 的 `lost-pulse` 是**无限循环**动画，
duration 压到 0.01ms 会导致它以极高频率重复播放——实际观感是**剧烈闪烁**，比不加 reduced-motion 更糟。

**建议**：对该类无限动画单独处理：

```css
@media (prefers-reduced-motion: reduce) {
  .stat.stat-lost.pulse { animation: none; border-color: var(--danger); box-shadow: 0 0 0 3px var(--lost-bg); }
}
```

---

## 5. 🔵 P3 规模化与功能补全（视增长再定）

当前 6 个项目时以下都**不是问题**，但库增长到 50+ 后会集中爆发。

### P3-1 列表接口裁剪与分页

`list_projects` 每次返回**全量项目**，且每条都做 `live_check`（`os.path.isdir` + 可能的 DB 写），
每条还携带完整 `path`、`intro`、`last_commit`、`tags`。50 个项目时首屏要传几十 KB 并做 50 次磁盘 IO。

**建议**：拆出轻量列表端点（只返回卡片所需字段），`live_check` 改为前端按需触发或后端异步；
前端加分页（每页 24）或虚拟滚动。

### P3-2 批量操作

首页无多选、无批量改状态 / 分类 / 标签、无批量删除、无批量导出。
用户整理 50 个项目的归档状态时需要逐个进详情页。

**建议**：卡片左上角加复选框（hover 或常驻），选中后顶部浮出操作条：
`批量归档 / 批量改分类 / 批量加标签 / 批量删除 / 导出所选`。

### P3-3 置顶 / 收藏 + 最近访问

无 pin 字段、无最近访问记录。项目多了以后，"正在做的 3 个"会被淹没在 50 张卡片里。

### P3-4 其他功能缺口

| 项 | 说明 |
|---|---|
| 卡片快捷改状态 | 现在改状态必须进详情页，可在卡片状态徽章上直接下拉 |
| 详情页上一项 / 下一项 | 详情页顶栏只有"返回首页"，应加同组项目的左右切换 |
| 主题三态 | 当前只有亮/暗二态切换，一旦手动切换就永久锁定 localStorage，不再跟随系统。应加"跟随系统" |
| 全局快捷键面板 | `/` 聚焦搜索已实现，但无 `?` 打开快捷键帮助；详情页无 `e` 编辑、`g d` 跳转等 |
| 截图管理 | 无排序、无重命名、无"设为封面"（首页卡片可显示封面图） |
| `@media print` | 已有导出 HTML，但直接打印页面会是整屏三栏布局 |

---

## 6. 分阶段路线图

> **2026-08-30 更新**：第 1、2、3 批已全部完成，第 4 批按触发条件暂缓。
> 下方保留原始排期用于追溯，完成状态见 §0.1。

```text
第 1 批 · 半天 · 修缺陷
  P0-1 dep-stats 结构错位        （project.html 移动 9 行）
  P0-2 卡片键盘可达性            （dashboard.html + 3 行 CSS）
  P0-3 行内操作可见性            （style.css 3 行）
  P0-4 顶栏 flex-wrap            （style.css 2 行）
  P0-5 改用 rescan-all 接口      （dashboard.js 约 20 行）
  P0-6 死代码清理                （约 12 处）
  → 交付：键盘可走通全流程，无结构错位，无死代码

第 2 批 · 1–2 天 · 补体验
  P1-1 统计卡下钻      P1-2 筛选补齐      P1-3 空结果清除筛选
  P1-4 卡片层级重排    P1-5 TOC 窄屏降级  P1-6 骨架屏
  P1-7 草稿保护        P1-8 上传反馈      P1-9 模态框 a11y
  P1-10 提交加载更多   P1-11 Toast 治理
  → 交付：首页筛选闭环、详情页窄屏可用、编辑内容不丢失

第 3 批 · 2–3 天 · 还设计债
  P2-1 状态色单一真源  P2-2 语义色 token  P2-3 间距/圆角/字号收敛
  P2-4 图标统一 SVG    P2-5 reduced-motion 修正
  → 交付：配色/间距/图标三套规范，新增页面零决策成本

第 4 批 · 按需 · 规模化
  P3-1 列表裁剪分页    P3-2 批量操作      P3-3 置顶与最近访问
  P3-4 其余功能缺口
  → 触发条件：库内项目数 > 30，或出现明确的批量整理诉求
```

---

## 7. 验收标准

改造完成后建议按以下清单自测：

**可达性**
- [ ] 纯键盘（只用 Tab / Enter / 方向键 / Esc）能完成：首页筛选 → 进入详情 → 编辑描述 → 保存 → 返回
- [ ] 所有仅图标按钮有可访问名称（`aria-label` 或可见文本）
- [ ] 打开任一弹窗后，Tab 不会聚焦到弹窗外；关闭后焦点回到触发按钮
- [ ] 卡片行内操作在触屏（或 DevTools 模拟 `hover: none`）下可见可点

**响应式**
- [ ] 1920 / 1440 / 1100 / 900 / 768 / 390 六档宽度下无横向滚动
- [ ] ≤1024px 时详情页仍有可用的面板导航（横向 chip 条）

**视觉一致**
- [ ] 修改 `--accent` 一个变量后，状态色、热力图、徽章、下拉全部跟随变化
- [ ] 亮/暗主题下所有文本对比度 ≥ 4.5:1（正文）/ 3:1（大字）
- [ ] 开启"减弱动态效果"后，丢失项目卡不再闪烁

**数据安全**
- [ ] 描述写到一半刷新页面，重新进入可恢复草稿
- [ ] 截图上传期间有明确加载状态，重复拖拽不会产生重复 toast

---

## 附：本次评审已确认的事实清单

| 事实 | 依据 |
|---|---|
| `dep-stats` 脱离 `.panel` 渲染，且存在孤立 `</section>` | `project.html:224 / 226-234 / 235` |
| 首页卡片无 `role` / `tabindex` / 键盘事件 | `dashboard.html:69-72` |
| 后端已有 `POST /api/projects/rescan-all`，前端未调用 | `routers/projects.py:274`；`dashboard.js:100-121` |
| 后端返回 `stack_summary`、`exists_now`，前端从未消费 | `routers/projects.py:85, 88`；全量 grep 无引用 |
| `descTab` / `descHtml` / `previewDesc` / `copyRel` 为死代码 | `project.js:61, 62, 461, 587` |
| `.md-tabs` / `.chip` / `.more-divider` / `.gap-left` / `.detail-head` 为死 CSS | `style.css:627, 292-298, 929-930, 440-446` |
| 状态色在 4 个选择器中重复定义 | `style.css:171-173, 211-214, 312-315, 343-346` |
| 顶栏无 `flex-wrap` 且 logo `nowrap` | `style.css:98-108` |
| TOC 在 ≤1024px 被 `display:none` 移除 | `style.css:723` |
| 当前库内 6 个项目，0 丢失，0 笔记 | `data/projects.db` 实测 |
