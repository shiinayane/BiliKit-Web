# Safari 新标签历史压扁

> 状态：用户脚本实现稿。实现日期：2026-07-21。  
> 目标：视频默认在独立标签打开；可选地保住 Safari“左滑关闭自动打开的子标签、回到来源页”的原生行为。

## 1. 这不是普通的浏览器后退

项目早期实测发现：Safari 中，由链接/点击自动打开、保留 `opener` 且历史深度仍为一层的视频子标签，两指左滑会关闭该子标签并回到来源标签。它不是脚本调用 `history.back()`，也不是脚本监听 wheel 后自行关闭。

一旦视频页连续 SPA 跳转为浏览器历史增加多层，Safari 会优先在子标签内后退，不能直接回到来源标签。因此旧版“回程”曾把跨视频 `pushState` 改成 `replaceState`。旧实现也曾尝试捕获链接点击并改用 `location.replace`；这会把 B 站 SPA 打断成整页加载，还可能和抽屉点击接管叠加造成双重加载与极端内存增长，所以本次明确不恢复点击拦截。

这项行为来自项目实机观察，不是跨浏览器 Web 标准保证。Safari 更新后仍需回归测试。

## 2. 当前产品决策

- 未保存过打开方式时，默认使用“新标签页”；已有 `feed.openMode` 设置原样保留。
- `feed.newTabHistoryFlatten` 是实验开关，默认关闭，仅 Safari 生效。
- 开关只影响 BiliKit-Web 自动打开的视频子标签；普通标签、手动修饰键打开、当前页和抽屉不受影响。
- Chrome、Edge、Firefox始终使用 `noopener`，不修改视频页 History。
- 被压掉的跨视频来时路仍由“回程”胶囊保存在 `sessionStorage`；用户可点胶囊返回并续播。

## 3. 运行链路

### 3.1 来源页打开

`openBiliKitVideoTab()` 先判断“开关开启 + Safari”：

- 不满足：继续使用 `window.open(url, '_blank', 'noopener')`；
- 满足：临时摘掉来源页的 `bilikit-wayback-stack`，使用唯一的 target name 打开子标签，再立即恢复来源栈。

唯一 target name 同时承担一次性能力标记和“每次一定新建 browsing context”两个职责。临时摘栈是为了防止 Safari 在同源 `window.open` 时把来源 `sessionStorage` 克隆进子标签，生成没有走过的幽灵来时路。

实验模式不能加 `noopener`：项目旧版实测 Safari 的原生左滑回来源依赖 opener 关系。这是明确的安全/体验取舍，因此开关默认关闭；目标严格限制为 B 站视频 URL，不用于任意外站。

### 3.2 子标签 document-start

Core 在任何可选模块之前读取 target name：

1. 只接受严格的 `bilikit-newtab-flatten-<token>`；
2. 只接受顶层窗口；
3. 立即清空 `window.name`，标记只消费一次；
4. 包装当前实例的 `history.pushState`。

跨视频同源播放路由才改为 `replaceState`。同视频 query、分 P、非播放页、跨源 URL原样调用 `pushState`。

“回程”模块稍后再包装这一层：它先记录旧视频，再调用 Core wrapper。由此真实 History 可以保持一层，而人工回退栈仍保留 A→B→C 的语义。即使用户关闭“回程”模块，一次性标记仍会被 Core 正常消费，不会把 `window.name` 留在标签中。

## 4. 明确保留的边界

- 不拦截 `<a>` 点击，不把 SPA 强制改成整页加载。
- 不包装 `replaceState`；B 站自身规范化 URL 可以继续工作。
- 不处理同视频分 P；它仍可增加一层原生历史。
- 真整页导航无法由上一 Document 的 `pushState` wrapper压扁，也保留原生历史。
- `Cmd/Ctrl` 点击、中键和普通手动标签不带能力标记。
- 若 popup被浏览器阻止，只恢复来源栈，不做额外导航。
- 扩展版不能直接假设 `tabs.create()` 具备相同 opener/Safari手势语义，迁移时必须单独做原型验证。

所以 UI 使用“Safari 左滑回到来源页（实验性）”，而不是承诺“任何情况下历史永远只有一层”。

## 5. 验证重点

自动测试覆盖：Safari识别、严格 target name、开关关闭时的 `noopener`、实验模式来源栈摘取/恢复、标记一次性消费和跨视频路由分类。

真机必须覆盖：

1. 首页、search/space跨子域分别打开；
2. A→B→C 后 `history.length` 不增长且回程栈有 A/B；
3. Safari左滑关闭子标签并回到来源；
4. 分 P、整页导航按文档保留原生历史；
5. 普通标签/当前页/抽屉不被压扁；
6. Chrome、Edge、Firefox始终维持 `noopener`。

完整手测矩阵见 [TESTING.md](TESTING.md#13-新标签默认值与-safari-历史压扁)。
