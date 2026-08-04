# 已知限制 · 技术详版（本地留档）

> 这是 [issue #4「已知限制汇总」](https://github.com/shiinayane/BiliKit/issues/4) 的**详细技术版**。公开 issue 只留给用户看的简短说明；这里保留完整的排查过程、死胡同、数据与方法，便于日后不必重走弯路。改动限制结论时，两处一起更新。

## 1. 播放时耗电快 / 发热（笼统反馈，暂无法定位）

有用户反馈「只要装了这个脚本、在 B 站页面，不论码率、不论是否在播放，就感觉发热」。

**已排查/排除**：
- 用 Safari Web Inspector 录制 Timeline 逐项比对过：回程模块（way-back）的持续动画/观察器已优化（`height` 动画改 `transform`、`timeupdate` 节流、去掉全文档 MutationObserver 等），主线程 JS 占用有实测下降；
- theme-sync 的全文档观察器也已收窄到评论容器；
- 不是解码码率问题（分别测过 480p / 1080p）；
- 不是「是否播放」导致（静止页面也报告发热）。

**目前结论**：反馈本身过于笼统（「只要在 B 站就热」覆盖面太大），且报告者本人也认为难以进一步定位、暂不再深挖。可能的方向（CDN 优选的全局 fetch/XHR hook 在 B 站高频后台请求下的常驻开销、或 B 站站点本身在 iPad Safari 上就偏重）尚未验证。

## 2. 音频响度均衡不可行

Safari 上 `createMediaElementSource` 接管 B 站 MSE 视频后，`AnalyserNode` 读到的数据全是零——这是 WebKit 的音频路由 bug，不是我们能绕过的。所以「响度均衡/音量拉平」这类基于 Web Audio API 分析音频的功能在 Safari + B 站视频上做不了。

## 3. 抽屉里用力甩，偶发露出白色（回弹瞬间）

**现象**：视频抽屉（底部上滑的 iframe 播放页）里，正常上下滑动没问题；但**用力甩**到内容边界、触发橡皮筋回弹时，深色模式下偶尔会闪一下**白色**，力道/速度不同、复现概率也不同（这也是最初排查困难的原因——不是每次都能触发）。

**排查过程**（按时间顺序，每一版都实测无效或被推翻）：
1. 给 iframe 文档的 `<html>`/`<body>` 用 `var(--bg1)`/固定深色垫底——针对「B 站深色只给部分容器上色，根元素仍白」这个猜想，无效；
2. 怀疑滚动惯性经由「滚动链」甩给了父页（首页/Feed），父页橡皮筋把整个 `position:fixed` 抽屉当刚体拽动——加 `overscroll-behavior`（iframe 内 `contain`/`none`，父页 `none`）+ 父页 `<body>` 定格（iOS 经典 `position:fixed` 锁滚动法）—— 均无效；
3. 怀疑抽屉常驻的 `transform:translateY(0)` 把面板提成合成层，圆角裁剪逃逸（与 Feed 封面圆角露缝同族问题）——settle 后切回 `transform:none`——无效；
4. **诊断探针法**：把 iframe 内所有候选层（父 html/body、抽屉面板、iframe 元素、遮罩、iframe 内文档 html/body）分别涂成不同鲜艳颜色实测——用力甩后**先看到一层能对上的颜色（说明那层确实在参与回弹路径），继续甩到底，最终露出的白色仍与所有候选色都对不上**；把 iframe 内**所有元素**强制刷成同一种绿色再甩，回弹处**依然是白色**——证明这块背景**不是任何可涂色的 DOM 元素**；
5. 查到 iOS/macOS Safari 的 overscroll 回弹只认 `<body>` 背景色、忽略 `<html>`——按此补 `<body>` 背景，仍未根治外层这条白；
6. 查到 CSS 工作组关于 `color-scheme` 的决议（iframe 与父文档配色不同时，WebKit 应给 iframe 一块配色相称的不透明 canvas）——给 iframe 文档声明 `color-scheme:dark`，实测无效；
7. 最后一个廉价实验：给 iframe 元素本身加 `-webkit-overflow-scrolling:touch`（历史上让 iOS 13 前的 iframe 具备独立动量滚动的手法），赌它能把 iframe 滚动纳入常规 `overflow` 滚动管线（背景/回弹可控）——实测**仍无效**。

**结论**：iOS/macOS Safari 里，`<iframe>` **自身的原生文档滚动**走的是一条独立于常规 `overflow:scroll` div 滚动的渲染/合成路径；其橡皮筋回弹的背衬面**不接入标准 CSS 渲染管线**——`background-color`（任何元素）、`color-scheme`、`overscroll-behavior` 均对它无效。这与「顶层页面文档」或「普通 `overflow:scroll` + `-webkit-overflow-scrolling:touch` 的 div」这两种更常见、网上教程覆盖的场景不是同一套实现，故那些标准解法都不适用。

**已知代价更高的绕过法（未采用）**：把 iframe 内容改造成「外层 `position:fixed` + 内部 `overflow:scroll` div」的滚动结构（即把原生文档滚动换成普通 div 滚动），理论上能让背景色重新生效——但这要求重构 iframe 内 B 站 SPA 页面的 DOM 结构，风险高（可能影响播放器铺满、吸顶、内部弹层定位等），且效果未经验证，暂不采用。

**目前处理**：接受为已知平台限制，代码里未保留任何针对性补丁（全部实测无效的尝试均已还原，避免留下死代码/误导性注释）。

## 4. 内存占用高（1–2GB，偶发峰值 2–3GB）——B 站地板 + 完整视频 iframe 生命周期残留

有反馈「装了脚本后 Safari 内存飙到 2–3GB」。用 `footprint <WebContent pid>` 做了 **A/B 定量对比**（macOS 26，同样刷首页 + 反复开关抽屉看视频）：

| | 关全部脚本（原生 B 站） | 装 BiliKit | 差值 |
|---|---|---|---|
| footprint 区间 | 1.0 → 1.5 GB（随用爬） | 1.4 → 1.7 GB | +250~400 MB |
| **峰值 peak** | **1642 MB** | **2198 MB** | **+556 MB** |
| WebKit malloc（WebCore C++ 堆） | 620→785 MB | ~880-920 MB | +~140 MB |
| graphics（合成面/位图） | 210→540 MB | ~400-610 MB | +~70 MB |
| JS 堆（Gigacage） | 46→72 MB | 105→141 MB | +~70 MB |
| **media（视频解码面）** | **4-37 MB** | **5-50 MB** | **≈0（都极小）** |

**这轮 A/B 的结论：**
- **B 站原生自己就 1.0–1.6GB 且随使用持续增长**——重型 SPA（首页 + 播放器 + 弹幕 + 评论）的固有重量，改不动，这是地板；
- **BiliKit 净增约 +300MB（峰值 +556MB），是少数派**，且分散在 WebCore 堆 / JS 堆 / 合成面；后续深入对照确认，其中很大一部分与「完整视频页 iframe 的首次生命周期」有关，见下节；
- **不是视频解码/MSE 缓冲占主体**——media 分区两边都只有个位到几十 MB；DOM 探针能证明抽屉 `<video>` 和 iframe 元素已拆除，但「DOM 已移除」不等于浏览器进程已归还 WebCore/allocator 内存；
- footprint 里有大量 **Reclaimable**（已 free 但分配器暂攥着的页，系统有压力即回收），所以活动监视器看到的数字偏虚高。

### 2026-07-20 深入对照：销毁、复用与顶层导航

为区分「WebKit 独有泄漏」「反复创建 iframe」和「B 站完整视频页本身很重」，在 Safari 与 Chrome 150 做了三组实机对照：

| 浏览器 / 路径 | 首页基线 | 视频加载期间 | 操作完成并等待后 | 净残留 |
|---|---:|---:|---:|---:|
| Safari：打开并销毁 iframe 3 次 | 449 MB | 最高 907 MB | 713 MB（强制 GC） | +264 MB |
| Safari：同一 iframe 内连续换 3 个视频，只销毁 1 次 | 372 MB | 829 → 792 → 743 MB | 630 MB | +258 MB |
| Chrome：打开并销毁 iframe 3 次 | 168 MB | 首次 581 MB | 458 MB | +290 MB |
| Chrome：同一 iframe 内连续换 3 个视频，只销毁 1 次 | 136 MB | 898 → 835 → 863 MB | 377 MB | +241 MB |
| Chrome：顶层视频页往返 3 次 | 186 MB | 首次 459 MB | 347 MB | +161 MB |
| Safari：顶层视频页往返 1 次 | 132 MB | 视频页进入独立 WebContent | 132 MB | 0 MB |

不同轮次的推荐视频不完全相同，因此绝对值不能横向当基准；有意义的是各组自己的增量和趋势：

- **不是 WebKit 独有**：Chromium 在移除完整视频 iframe 后同样留下数百 MB；问题是 B 站完整视频页、浏览上下文销毁、浏览器 allocator / 页面缓存共同作用，不能只归因于 Safari；
- **复用 iframe 元素、但每个不同视频换新 Document，能防止继续线性爬升**：同一个 iframe browsing context 内整页切换第二、第三个视频时，两种浏览器都围绕首次加载后的平台波动，没有按视频数继续增加；这不等于复用 B 站视频 SPA 应用；
- **销毁 iframe 不能保证回到首页基线**：无论 `remove()`、`contentWindow.close()`、子页停媒体、先跳 `about:blank`、等待还是 GC，首次完整视频页生命周期后仍约残留 240–290MB；连续销毁会增加瞬时高点，Chrome 稳定值也比单次销毁更高；
- **Safari 顶层导航的释放最干净**：视频页进入独立 WebContent，返回首页后视频进程退出，首页进程保持原值。Chrome 本轮复用了同一个 Renderer，返回后的残留较 iframe 少，但不是零；
- Safari 对高占用进程跑 `heap` 时还能看到旧 `WebCore::HTMLDocument` 由 `allScriptExecutionContextsMap`、`LocalDOMWindow`、渲染合成相关对象继续持有；`leaks` 只报约 28KB 传统泄漏。这更像 WebCore 生命周期/缓存和 allocator 驻留，而不是一个简单的 JS detached DOM 或视频缓冲泄漏。

### 2026-07-21 补充观察：当前版本没有表现出更快的持续增长

用户在同一台机器上追加观察：关闭全部脚本时，B 站网页稳定约 **1.2GB**，打开普通视频页约 **1.4GB**；开启当前 BiliKit 后虽然绝对值约稳定在 **1.6GB**、偶尔到 **2GB**，但峰值会回落，连续使用时反而没有原生页面增长得快。

这组数据支持“当前实现是较高但有界的平台，而非按操作次数持续泄漏”，也与 Feed 窗口化、媒体有界释放和抽屉跨视频换 Document 的设计方向一致。但它不是严格匹配时长、推荐内容与操作序列的新一轮 A/B，不能据此宣称“脚本会降低 Safari 内存”；更稳妥的结论是：**绝对 footprint 与增长斜率是两件事，当前没有观察到 BiliKit 导致更快的单调增长。**

**采用的架构：单 iframe 元素 + 每个不同视频一个新 Document。** 整个顶层标签页的 DOM 始终至多一个抽屉 iframe；关闭时通过 `suspend → ack`（消息丢失会重试）暂停子页媒体，再用 3 秒短守卫压住异步 autoplay，结束可见合成并隐藏面板，但不移除 browsing context。打开不同视频时先等旧文档确认暂停（子页脚本缺失时最多等 350ms），随后由子页在同一 iframe 内 `location.replace`，让旧 Vue 应用、播放器、评论树和媒体文档完整走 `pagehide/unload`；抽屉内部点击会在捕获阶段先于 Vue Router 接管，`pushState/replaceState` 包装与 500ms 内容 ID 检查再兜程序化跳转。已覆盖普通视频、番剧/课程、分 P，以及带 `bvid/aid/oid` 的列表/活动播放 URL；无法提取稳定内容 ID 的特殊活动 URL 保守放行，仍是已知边界。每个 Document 使用独立 nonce，拒绝旧文档迟到的 ready/location 消息。新文档先保持暂停，首帧就绪后严格按「撤遮罩 → 恢复播放」排序；浏览器 Forward 重开同一视频时才直接复用原文档。若 replace 已接受但 15 秒仍无新 nonce 握手，或未 ready 文档连 suspend 都无确认，会先移除旧 iframe 再以初始导航顺序重建一个；这是错误页/断网的有界恢复路径，不会让新旧 iframe 并存。这样接受“首页 + 最后一个完整视频页”的数百 MB 驻留，但避免把多个视频世代堆在一个 SPA 文档里。若目标是「关闭抽屉就显著回收」，常驻 iframe 仍做不到，需要使用下述顶层导航或独立标签/窗口。

**顶层导航落地：** Feed 的「当前页」模式现会在离开前把卡片数据、推荐游标与滚动位置存入标签页级 `sessionStorage`，返回首页后一次性恢复；不保活 DOM/媒体上下文。对 B 站当前视频包的逆向确认，相关推荐 SPA 是只在视频页应用壳内创建的私有 Vue Router，首页没有可复用的全局入口；强行复用必须自行搬运整个视频应用，反而会把首页与视频重量留在同一 WebContent。详见 [首页 → 视频的顶层导航与状态恢复](RESEARCH-top-level-navigation.md)。

**已做的缓解：** 抽屉采用唯一 iframe 元素 + 不同视频强制换 Document + 关闭/换片前可靠 suspend；不再尝试跨视频复用 B 站 SPA。Feed 使用真·窗口化（DOM 节点有界）+ 封面屏外卸载 + hover 预览并发上限。（注：封面 `isolation:isolate` 曾于 0.3.17 改为「仅预览时按需加」以省合成面，但按需增删会 churn 合成层致邻卡露缝，0.3.19 已改回常驻——详见 `src/feed/styles.ts` 里 `.bk-feed-cover` 的注释。）这些控制的是脚本自身和跨视频 SPA 的无界增长，但**动不了 B 站自身与最后一个完整视频页的内存地板**。

**一句话：B 站本身提供了很高的内存地板；新安装默认使用独立新标签（Safari 可选[历史压扁](RESEARCH-new-tab-history.md)），抽屉则接受唯一完整视频 iframe 的稳定驻留并以复用防止继续爬升；追求同标签回收时使用「当前页」顶层导航。**

**排查方法留档**（便于以后复现，不必重走弯路）：
- 内存分区看构成：`footprint <pid>` 或 `vmmap --summary <pid>`（pid 从活动监视器取 `com.apple.WebKit.WebContent`）；重点看 `media`（视频）与 `WebKit malloc / graphics / JS`（站点堆）的占比；
- 判「我们 vs B 站」：关脚本跑原生做 A/B；
- DOM 层实时侧测（Safari 无 JS 堆 API）：`tools/bilikit-mem-probe.user.js`（穿透同源 iframe 数各来源 `<video>` 的 buffered、DOM 节点数、objectURL 收支）。

## 5. 免登录（no-login）的固有限制——伪造登录态换来的取舍

免登录靠「伪造 `DedeUserID` cookie + 把 nav/relation 等响应改写成已登录」让未登录也能看评论/动态/1080p，本质是**只读的障眼法**：页面「以为」你已登录，但你并没有真会话。由此带来几条**无法绕过**的限制——不是 bug，是这套做法的必然取舍：

- **看不到评论 IP 属地** —— 评论必须走匿名请求（`credentials:'omit'`）才能放行公开评论；而 B 站服务端**只对真登录**的请求在评论数据里返回属地字段，匿名请求拿不到。所以免登录开启时「评论属地」模块显示不出属地——**两者不可兼得**。
- **一切需真鉴权的操作都会失败** —— 发评论、点赞、投币、收藏、追番、历史 / 稍后再看同步等，服务端按真实（未登录）身份拒绝。纯只读浏览。
- **1080p 是官方「试看」上限** —— 靠 `try_look` 拿到 1080p 试看流，4K / HDR / 大会员专享清晰度仍拿不到（需真大会员鉴权）。
- **仅未登录时生效** —— 登录 cookie 存在时会用 nav 确认服务端登录状态；真登录整体让路。若只是残留的失效
  `DedeUserID__ckMd5`，会在当前标签页记录结论并刷新一次，让免登录从下一个 `document-start` 正常接管。

**结论**：这些都是「伪造登录态」这条路线换来的代价，属**设计取舍而非可修的 bug**。顶栏「退出登录」会直接跳登录页（登录后自动回到当前页），是从免登录切回真登录的入口。做法逆向自 beefreely，详见 [RESEARCH-no-login.md](RESEARCH-no-login.md)。
