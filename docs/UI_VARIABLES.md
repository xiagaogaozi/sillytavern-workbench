# UI变量与界面约定

同步日期：2026-10-30。作用域：本扩展iframe；实际变量源 `ui.css`，运行时主题映射在 `src/app.js`，宿主视口尺寸适配在 `src/host.js`。

## 变量表

所有名称均使用 `--pww-*`。基础间距、语义颜色和组件尺寸在唯一样式表集中定义；表内为默认值，主题与用户设置可覆盖。

| 变量 | 默认值/引用 | 中文用途 | 状态 |
|---|---|---|---|
| `--pww-background` | `var(--SmartThemeBlurTintColor, #171a20)` | 主窗口背景，默认继承酒馆主题 | 使用中 |
| `--pww-text` | `var(--SmartThemeBodyColor, #e3e7ed)` | 正文前景色 | 使用中 |
| `--pww-muted` | `var(--SmartThemeEmColor, #a0a9b9)` | 次要文字与说明色 | 使用中 |
| `--pww-accent` | `var(--SmartThemeQuoteColor, #76c6b0)` | 主操作与选择强调色 | 使用中 |
| `--pww-border` | `color-mix(in srgb, var(--pww-text) 17%, var(--pww-background))` | 面板及控件边界 | 使用中 |
| `--pww-surface` | `color-mix(in srgb, var(--pww-background) 95%, var(--pww-text))` | 工具栏和抬升面板背景 | 使用中 |
| `--pww-entry` | `color-mix(in srgb, var(--pww-background) 97%, var(--pww-text))` | 条目行背景 | 使用中 |
| `--pww-input` | `color-mix(in srgb, var(--pww-background) 92%, black)` | 输入框与正文预览背景 | 使用中 |
| `--pww-hover` | `color-mix(in srgb, var(--pww-text) 8%, transparent)` | 可交互元素悬停底色 | 使用中 |
| `--pww-selected` | `color-mix(in srgb, var(--pww-accent) 12%, var(--pww-background))` | 选中条目与提案底色 | 使用中 |
| `--pww-danger` | `#e98f96` | 删除、错误提示色 | 使用中 |
| `--pww-success` | `#77cba5` | 成功、激活提示色 | 使用中 |
| `--pww-deleted` | `color-mix(in srgb, var(--pww-danger) 20%, transparent)` | 差异删除区域底色 | 使用中 |
| `--pww-added` | `color-mix(in srgb, var(--pww-success) 20%, transparent)` | 差异新增区域底色 | 使用中 |
| `--pww-icon-color` | `var(--pww-muted)` | 功能图标颜色 | 使用中 |
| `--pww-space-1` | `4px` | 基础间距第1级 | 使用中 |
| `--pww-space-2` | `8px` | 基础间距第2级 | 使用中 |
| `--pww-space-3` | `12px` | 基础间距第3级 | 使用中 |
| `--pww-space-4` | `16px` | 基础间距第4级 | 使用中 |
| `--pww-space-5` | `24px` | 基础间距第5级 | 使用中 |
| `--pww-space-6` | `32px` | 基础间距第6级 | 使用中 |
| `--pww-radius` | `8px` | 标准圆角 | 使用中 |
| `--pww-radius-sm` | `5px` | 控件小圆角 | 使用中 |
| `--pww-window-radius` | `12px` | 窗口和主要容器圆角 | 使用中 |
| `--pww-scale` | `1` | 用户字号倍率 | 使用中 |
| `--pww-font` | `calc(var(--mainFontSize, 15px) * var(--pww-scale))` | 工作台根字号，继承酒馆字号再乘倍率 | 使用中 |
| `--pww-small` | `.8rem` | 次要界面文字字号 | 使用中 |
| `--pww-title` | `1.1rem` | 主标题字号 | 使用中 |
| `--pww-leading` | `1.5` | 正文基础行高 | 使用中 |
| `--pww-weight` | `600` | 标题/操作强调字重 | 使用中 |
| `--pww-control` | `44px` | 按钮与触控目标最小高度 | 使用中 |
| `--pww-row-min` | `56px` | 条目行最小高度 | 使用中 |
| `--pww-line` | `1px` | 常规边框宽度 | 使用中 |
| `--pww-focus` | `2px` | 键盘焦点描边宽度 | 使用中 |
| `--pww-ai-width` | `360px` | 桌面AI侧栏宽度 | 使用中 |
| `--pww-max-width` | `1680px` | 非全屏桌面窗口最大宽度；默认全屏不受此值限制 | 使用中 |
| `--pww-sheet` | `680px` | 普通弹窗宽度 | 使用中 |
| `--pww-sheet-wide` | `1100px` | 宽弹窗宽度 | 使用中 |
| `--pww-shadow` | `0 16px 64px #0006` | 独立窗口/提示的投影 | 使用中 |
| `--pww-overlay` | `#0008` | 弹窗遮罩 | 使用中 |
| `--pww-motion` | `140ms` | 普通交互过渡时长 | 使用中 |
| `--pww-ease` | `ease-out` | 交互过渡缓动 | 使用中 |
| `--pww-z-drawer` | `20` | 窄屏AI抽屉层级 | 使用中 |
| `--pww-z-toast` | `100` | 状态提示层级 | 使用中 |
| `--pww-z-drag` | `200` | 拖拽反馈层级 | 使用中 |
| `--pww-background-image` | `none` | 用户上传的背景图 | 使用中 |
| `--pww-checkbox` | `18px` | 复选框图形尺寸 | 使用中 |
| `--pww-brand-size` | `38px` | 桌面标识尺寸 | 使用中 |
| `--pww-empty-size` | `64px` | 空态标识尺寸 | 使用中 |
| `--pww-entry-indent` | `70px` | 桌面条目信息左缩进 | 使用中 |
| `--pww-switch-width` | `30px` | 开关轨道宽度 | 使用中 |
| `--pww-switch-height` | `18px` | 开关轨道高度 | 使用中 |
| `--pww-switch-knob` | `12px` | 开关滑块尺寸及移动距离 | 使用中 |
| `--pww-switch-offset` | `2px` | 开关滑块内边距 | 使用中 |
| `--pww-preview-height` | `400px` | 长正文/流响应预览高度上限 | 使用中 |
| `--pww-generation-preview-height` | `320px` | 生成条目正文预览高度上限 | 使用中 |
| `--pww-response-height` | `360px` | 项目响应诊断高度上限 | 使用中 |
| `--pww-drawer-width` | `420px` | 窄屏AI抽屉最大宽度 | 使用中 |
| `--pww-toast-width` | `480px` | 通知最大宽度 | 使用中 |
| `--pww-filter-width` | `116px` | 桌面筛选框宽度上限 | 使用中 |
| `--pww-select-width` | `160px` | 列表附加选择器宽度上限 | 使用中 |
| `--pww-mobile-filter-width` | `100px` | 手机筛选框宽度上限 | 使用中 |
| `--pww-graph-min` | `500px` | 关系图最小可读宽度 | 使用中 |
| `--pww-graph-max` | `800px` | 关系图最大显示宽度 | 使用中 |
| `--pww-mode-min` | `88px` | 桌面模式切换按钮最小宽度 | 使用中 |
| `--pww-indicator` | `3px` | 条目选中/激活侧边标记宽度 | 使用中 |
| `--pww-disabled-opacity` | `.5` | 禁用控件及禁用条目文字透明度 | 使用中 |
| `--pww-placeholder-opacity` | `.8` | 占位文字透明度 | 使用中 |
| `--pww-form-font` | `.9rem` | 表单标签和表格字号 | 使用中 |
| `--pww-heading-font` | `1.05rem` | 次级标题字号 | 使用中 |
| `--pww-code-font` | `var(--monoFontFamily,ui-monospace)` | JSON与脚本编辑器等宽字体 | 使用中 |

## 宿主变量映射

- `--SmartThemeBodyColor`、`--SmartThemeEmColor`：正文/次要文字。
- `--SmartThemeBlurTintColor`、`--SmartThemeBorderColor`、`--SmartThemeQuoteColor`、`--SmartThemeShadowColor`：表面/边界/强调/阴影来源；工作台语义色根据背景与前景组合。
- `--mainFontSize`、`--mainFontFamily`、`--monoFontFamily`：字体基础。
- 默认跟随酒馆；设置支持深色、浅色与用户颜色覆盖。根据宿主背景亮度同步原生控件color-scheme。
- 背景图片在导入时缩至最大1600px宽的JPEG，避免把原始大图塞入共享设置。

## 主题覆盖

### 浅色

```css
--pww-background:#f7f8fa;--pww-text:#252c37;--pww-muted:#687182;--pww-accent:#267b67;--pww-input:#fff;--pww-danger:#b3424e;--pww-success:#267754;color-scheme:light;
```

### 深色

```css
--pww-background:#171b22;--pww-text:#e3e7ee;--pww-muted:#a1aabb;--pww-accent:#7bc7b0;color-scheme:dark;
```

浅色宿主（包括跟随模式）使用更深的语义色：`--pww-danger: #9a2d3e`、`--pww-success: #226442`，保证提示文字在浅色表面可辨读。

## 响应式与交互

- ≥1280px：双栏与360px AI侧栏并列。
- 960–1279px：双栏保留，AI作为不压缩列表的抽屉。
- <960px：左右侧切换；低频排序/分组/开关方案在更多菜单中同样可达。主工具栏保留双栏模式、整理、比较与AI。
- 窗口使用visualViewport的显式尺寸，不覆盖宿主html/body样式，可适应带transform的主题。
- 弹窗只有内容区滚动，底部动作固定；手机详情在短视口仍保留保存动作。
- 长按阈值300ms、换侧停留400ms为手势参数，位于app.js；同一手势期间根据接近列表边缘的位置滚动。
- 工作台默认全屏，复用 `.workbench.fullscreen`：宽度100%、高度100dvh、无外边距/外边框/外圆角，铺满浏览器可视区域（不调用浏览器F11全屏）。设置中的“全屏工作台”默认及恢复默认均为开启；主动取消后桌面恢复带边距窗口，手机仍占满视口。
- 原生button/input/select/textarea提供键盘操作；表单使用明确for/id标签；状态提示使用aria-live；差异既有文字标识又有新增/删除标记。
- prefers-reduced-motion时移除过渡。

## 图标与例外

- 宿主仅保留输入框旁扩展菜单的工作台入口，移除扩展设置区重复的“打开酒馆工作台”按钮。入口使用酒馆已有Font Awesome书本图标；工作台用文字动作、原生复选框、开关和拖柄，不引入另一个图标依赖。
- 0、auto、inherit、百分比、dvh/vw约束、SVG图形坐标、可访问性视觉隐藏1px、计算结果不强行包装为变量。
- CSS媒体查询的959/1279断点不使用不受支持的var()写法；它们是宽度布局边界；短视口另有600px高度边界，见文末补充。
- 项目关系图中的行距、连线控制点与缩进为图示算法坐标，不改变业务深度或注入顺序。

## 同步核对

本表从实际CSS声明提取，覆盖全部在用pww变量。代码检查包含变量自引用和文档遗漏检查。废弃变量：无。

2026-10-27 同步：删除扩展设置区重复入口；默认全屏并同步当前共享设置。复用现有 `.workbench.fullscreen` 和宿主 visualViewport 适配；`--pww-max-width`、`--pww-space-4`、`--pww-space-6`、`--pww-window-radius`、`--pww-line` 仍用于非全屏窗口，背景/字体/响应式变量不变。无新增、改值或废弃变量；已核对渲染条件、设置默认及恢复默认一致。

## 2026-10-30 数据库管理与批量操作同步

- 新增选择后直接显示的 `.batch-toolbar`：显示筛选外选中数量以及启用、关闭、复制、删除、取消选择；位于列表上方，不遮挡条目或保存按钮。
- 数据库子页复用工作台全屏、双栏、AI侧栏、移动端左右切换及弹窗。新增 `.db-tabs`、`.db-unit`、`.db-segment` 等组件类，不增加外部样式依赖。
- 复用 `--pww-space-1/2/3/4`、`--pww-line`、`--pww-accent`、`--pww-selected`、`--pww-entry`、`--pww-border`、`--pww-small`、`--pww-muted`、`--pww-radius`、`--pww-control`、`--pww-weight`；值不变，使用位置扩展到上述组件。
- 手机工具栏按可用宽度换行，保留44px触控目标；数据库操作页底部保存/应用动作保持可见。手势使用原有300ms长按、400ms换侧；坐标和边缘滚动属于交互算法，不作为主题变量。
- 新增/修改/废弃变量：无。继续使用959/1279px两个宽度布局边界；已核对使用变量均在本表中有定义。

### 短视口补充核对（2026-10-30）

- 390×480 模拟软键盘视口检查发现，操作条叠加后整侧内容可能高于剩余高度。因此在高度≤600px时允许 `.pane` 整侧滚动，条目列表的高度上限为视口一半（50dvh），保存动作可以通过该侧滚动触达；不添加滚动位置拦截。
- 600px 是本次新增的高度布局边界（proposed default），不替代959/1279px两个宽度边界。50dvh为视口约束，依照本文“例外”不新增主题变量。编辑弹窗仍沿用内容滚动和底部动作区。

### 选择框宽度修复（2026-10-30）

- 数据库载入选项不再拼接全部聊天名称，改为“预设名称＋使用状态／已绑定N个聊天”；选中项的完整名称和绑定列表在下方可展开区域显示。
- 原生select弹层宽度取决于选项文字，单独限制select的CSS宽度不够。`src/ui.js` 在弹窗显示、变宽和选择变化时，按实际控件宽度及字体测量选项显示文本，超长部分省略；完整value保持不变，完整显示名保留在title中。ResizeObserver仅作用于本扩展的当前弹窗，关闭时释放。
- 复用 `--pww-control` 作为原生箭头留白预算，复用 `--pww-space-2/3/4/5`、`--pww-muted`、`--pww-small`。绑定明细的30dvh为视口约束，不新增主题变量。弹窗最大宽度同步受视口约束。
- 新增/改值/废弃变量：无。只改变显示和布局，不改预设名、选择值、绑定或运行配置。

### 新建模板与另存为（2026-10-30 / 0.2.1）

- 五类文档主栏标题区都直接显示“另存为”。文档、条目、完整字段、正文全屏、工具绑定/结构化消息、剧情提示词段等内容编辑弹窗，在原保存按钮旁增加“另存为…”。
- 另存会把当前编辑框的未提交字段放入独立副本，原文档和原草稿保持不变；命名、保存失败或取消都保留编辑输入。成功后仍留在当前编辑器，通过载入/切换打开副本；不隐式应用新预设。
- 复用 `--pww-control`、现有按钮/表单/弹窗/间距变量；标题动作和弹窗底部按可用宽度换行。新增/修改/废弃变量：无。
- 运行配置、API连接和AI系统提示词设置不是酒馆文档副本，不混入“另存为新预设”；生成项目仍使用独立项目复制/导出流程。

### 提示词预设与中文输入（2026-10-30 / 0.3.0）

- 数据库模块新增提示词预设分类选择、原生分组筛选与分组标题；复用现有按钮、表单、差异、批量操作及全屏/抽屉布局。
- 复用 --pww-font、--pww-accent、--pww-space-3 和 --pww-select-width；分组筛选与统计允许换行，统计和复选标签不被压成竖排。没有新增、改值或废弃视觉变量。
- 宽度≤959px时，数据库每侧整体可滚动，列表高度40–50dvh，避免新增选择框后把列表压到零高；40/50dvh是视口约束例外，不是独立主题尺寸。保存操作可以通过该侧滚动触达，继续保留既有高度≤600px规则。
- 搜索组合输入期间保留输入节点；只在提交最终文本后更新列表和计数，不做全局按键/滚动拦截。此变更无视觉变量变化。

- 同轮补充：世界书库管理弹窗的搜索也复用组合输入处理，并只替换书目结果，保留顶部搜索行。仍无新增视觉变量。

### 紧凑工具栏与滚动区扩容（2026-10-31 / 0.3.1）

- 删除工作台头部的 W/D 品牌图标、主标题和副标题；功能导航与关闭按钮保留。编辑弹窗的文档标题保留为单行省略，完整文字仍在标题属性中，避免失去编辑目标。
- 分类和全局操作合并为单行工具条；每侧搜索、筛选、统计/分组也合并成单行。宽度不足时横向滚动，而不是叠加多排；键盘可聚焦工具条，触控尺寸仍使用 --pww-control=44px。
- 导出、统计、预览应用移至文档操作条，删除底部重复动作及无交互提示条；保存、另存为、左右来源及保存状态保留。批量/条目动作也尽量单行展示。
- 复用 --pww-space-1/2、--pww-control、--pww-select-width、--pww-font、--pww-small、--pww-border、--pww-line 等变量；没有新增或修改变量值。--pww-brand-size 对当前头部已不使用，保留旧样式定义兼容，不再生成品牌节点。
- 取消0.3.0手机列表40–50dvh上限及短视口整侧滚动规则的实际生效范围，列表直接占满剩余高度，保持独立纵向滚动。全屏/visualViewport宿主代码不变。
- 弹窗最大高度为视口减 --pww-space-2，头尾留白压缩、按钮单行；来源提示最长35%为内容分配比例，属于布局计算例外，不增加主题变量。959px继续沿用已有布局断点。
- 横向工具条滚动位置在重绘时保留；不拦截滚轮、触摸或输入法事件，中文搜索仍保留原输入节点。

### 预设列表、应用反馈与查找替换（2026-10-31 / 0.3.1）

- 数据库每侧操作行直接展示“已保存预设”下拉框、保存、应用、另存为、更多。下拉框复用 --pww-select-width 与 --pww-mobile-filter-width，按钮仍为 --pww-control=44px；窄屏优先保证列表/保存/应用可见。
- 列表进入页面自动读取，保存完成即更新；选中只载入草稿，应用明确预览确认。列表可在下拉末项或更多菜单手动刷新，长名称继续使用原生选项测量省略，不改真实名称和值。
- 操作中状态复用 --pww-accent、--pww-small、--pww-space-1/2；弹窗新增 form-status 行，开始请求即显示，失败保留表单。提交期间禁用重复提交和关闭，避免把关闭弹窗误当作撤销写入。
- 数据库全局查找替换入口位于顶部操作条和每侧“更多”。替换配置、勾选预览和按需展开差异复用现有 field/check/db-segment/diff 样式，无新增视觉变量。
- 修正宽弹窗 max-height 的优先级，表单上限另减两条边框，保证480px短视口底部按钮不被裁切。无新增或改值变量。
