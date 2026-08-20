# BiliKit-Web Feed 虚拟化设计

## 问题（来自性能审查）

无虚拟化 → 卡片 DOM / `cardIo` 观察目标 / 每卡监听器 / 被 click 闭包钉住的 `FeedCard`
随滚动**单调增长、永不释放**。`content-visibility:auto` 只跳过屏外的布局/绘制，**不回收节点**。
封面位图已在屏外卸载（`src=BLANK`），但节点/观察者/监听器仍累积 → 长会话内存/CPU 线性上升，
顶到 Gate 那种 ~2GB 画像。

## 约束（必须保住）

- **无框架、纯 DOM、Safari**。
- **不能闪屏**——这是当初否掉 react-virtuoso、选 content-visibility 的原因；虚拟化不能把它带回来。
- **响应式 grid**：`repeat(auto-fill, minmax(300px,1fr))`，列数随宽度变。
- **卡片近等高**：高度由 16:9 封面主导（标题 1–2 行的差异 <20px）→ 可按「近似行高」估算，误差小。
- 必须兼容现有机制：`loadMore`/哨兵触底、骨架占位、`cardIo` 封面懒加载/屏外卸载、hover 雪碧图预览、
  代际令牌 `feedGen`、`seen` 去重、刷新/SPA 重入清理。

## 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A 精确行窗口 + 占位 | 保留 `items: FeedCard[]` 全量数据；只渲染可视行 ±buffer 的卡；上下用整行占位 div(`grid-column:1/-1`)撑高度保滚动位置 | 真·有界 DOM；标准做法 | 需算列数/行高；resize 重算；~150 行 |
| B 只裁顶 | 向下滚时把「远在上方（>N 屏）」的卡从顶部移除、等量增加顶部占位；滚回顶再从 `items` 重建 | 实现较简单；用实测高度无漂移 | 只解决向下滚的累积；结构略 hack |
| C 维持现状 + 上限 | 保留 content-visibility，仅在总数超阈值时裁最老的卡 | 改动最小 | 治标；向上滚回需重建 |

## 推荐：方案 A（精确行窗口 + 占位行）

近等高 grid 用「统一行高」模型即可精确窗口化，是内存问题的根治，且滚动位置稳定。
节点**按 item 下标 key、只在窗口边缘增删（不中途回收复用）**——避免「同一节点换内容」引起的
封面重载/闪烁；配合足够 buffer（~1.5 屏），封面在进入可视区前就加载好，无 pop-in。

### 数据模型
- `items: FeedCard[]`：全部已加载卡的**数据**（字符串，便宜），唯一真源。
- `nodes = new Map<number, HTMLElement>()`：当前已渲染的 `下标 → 卡片节点`。
- 上/下占位：`topSpacer` / `bottomSpacer`（`grid-column:1/-1`，高度 = 行数 × 行高）。

### 关键量
- `cols`：由 grid 实际列数推出（`getComputedStyle(grid).gridTemplateColumns` 数格子，或量首行）。
- `rowH`：量一张真实卡片高度 + `row-gap`；随窗口刷新时校正。
- 可视行范围：`start = floor(scrollTop/rowH) - BUF`，`end = ceil((scrollTop+vh)/rowH) + BUF`（BUF≈2 行/约 1.5 屏）。

### 渲染（`render()`，rAF 节流的 scroll 里调）
1. 由 `scrollTop`（grid 相对文档的偏移换算）得 `[startRow,endRow]` → `[startIdx,endIdx]`。
2. `topSpacer.height = startRow*rowH`；`bottomSpacer.height = (totalRows-endRow)*rowH`。
3. 增删差集：为新进窗口的下标 `makeCard`+`cardIo.observe`+插入到正确位置；为离开窗口的下标
   `cardIo.unobserve`+移除节点（连同其监听器/闭包一起被 GC）。
4. 哨兵放在 `bottomSpacer` 之后；触底逻辑不变。

## 分阶段实施（每阶段可独立构建、你验证）

- **P1 铺底（行为不变）**：引入 `items[]` 与 `render()`，但 `render()` 先渲染**全部**（等价现状）。
  loadMore 改为 push 进 `items` 再 `render()`。回归确认滚动/骨架/hover/刷新都正常。
- **P2 加窗口**：`render()` 只渲染窗口 + 上下占位；加 rAF 节流的 scroll 监听算范围；节点按下标增删。
- **P3 接线**：`cardIo` 随增删 observe/unobserve；hover 预览在新建节点上重挂；哨兵置于底部占位后；
  代际令牌/刷新/重入路径清空 `items`+`nodes`+占位。
- **P4 边界**：resize 重算 `cols`/`rowH` 并保持滚动锚点；刷新回顶；`exhausted` 提示；
  真机验证内存不再随滚动增长（长滚后 DOM 节点数稳定在窗口大小量级）。

## 坑位

- **列数/行高误差**：标题 1 vs 2 行造成微小高差 → 用「最大高度」当 `rowH` 略过量渲染，避免负 buffer 露白。
- **content-visibility 必须去掉**（P2 实测 + 网络调研纠正了原判断）：CV 会让「窗口内但不在视口」的卡
  塌回 `contain-intrinsic-size`，与视口内卡的真实高不一致 → 向上滚时总高在两值间抖动 → 抽搐。
  真·窗口化已把 DOM 限制在可视附近，CV 是多余且有害的。去掉后每卡真实等高，占位估算精确，无需
  scrollTop 补偿。（业界解法：TanStack `shouldAdjustScrollPositionOnItemSizeChange`、react-virtuoso
  ResizeObserver 测量替换估值；我们靠 min-height 强制等高绕开了变高问题。）
- **scroll 容器**：首页是 window 滚动；`scrollTop` 用 `window.scrollY`，grid 顶偏移用 `grid.offsetTop`。
- **封面重载**：滚回已卸载区会重新 `makeCard` → 封面重新请求（缓存通常命中）。可接受。
- **hover 预览**：节点销毁时若正在预览，rAF/timer 随闭包丢弃即可（`stop()` 依赖节点在场）；
  确认移除节点不残留运行中的 rAF（销毁前调用一次清理，或让 `hovering` 判空自然停）。
