<div align="center">
  <img src="assets/logo.png" width="112" height="112" alt="BiliKit-Web logo">
  <h1>BiliKit-Web</h1>
</div>

> 一套对 **macOS Safari** 友好的 B 站增强油猴脚本。无需浏览器扩展、零外部依赖，只用脚本管理器即可。

> [!WARNING]
> **开发期 · 快速迭代中**：BiliKit-Web 仍在积极开发，版本更新频繁、功能可能随时调整，偶有不稳定属正常。B 站接口一变也可能短暂失效。遇到问题或有建议欢迎提 [Issue](https://github.com/shiinayane/BiliKit-Web/issues)。

海外看 B 站卡成幻灯片？想要手机 App 那种更懂你的推荐？评论想看属地、看片不息屏、主题跟系统走？
BiliKit-Web 用**两个脚本**一次解决——核心增强 + 首页推荐流。

## 两个主件

| 脚本 | 一句话 |
|---|---|
| 🧩 **BiliKit-Web Core** | 一装到位的核心增强：**CDN 优选**（救海外卡顿）· **免登录**看评论/动态/1080p · **主题**跟随系统 · 评论显**性别 / IP 属地** · 播放**不息屏** · 视频页**回程**胶囊，外加一个**统一设置面板**。 |
| 📺 **BiliKit-Web Feed** | 把 B 站首页换成手机 **App 的个性化推荐流**；视频默认开**新标签页**，也可选当前页或底部抽屉；封面**悬停秒预览**，窗口化虚拟化**滚动不卡**。（需 Core） |

Core 独立可用；Feed 依赖 Core 提供登录与设置。只装其一时，另一个会在页面上提示补装。

## 安装

1. 装脚本管理器：Safari 用 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)，其它浏览器 [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/)。
2. 从 **GreasyFork** 安装：
   - 🧩 [**BiliKit-Web Core**](https://greasyfork.org/zh-CN/scripts/585248-bilikit-core) — 建议先装。
   - 📺 [**BiliKit-Web Feed**](https://greasyfork.org/zh-CN/scripts/585249-bilikit-feed) — 想要 App 推荐流再加装（需 Core）。

   或在 GreasyFork 搜索 [「BiliKit-Web」](https://greasyfork.org/scripts?q=BiliKit-Web) 查看全部。
3. 或自行构建：`pnpm install && npm run build`，从 `dist/` 里安装生成的 `.user.js`。

> **开发者**：`npm run test`（Vitest）只测「纯逻辑」层——URL/参数解析、wbi 签名、回程栈运算、CDN 主机改写、跨子域敏感键过滤等（`src/**/*.test.ts`，不碰 DOM/网络）。集成逻辑靠代码审查、站点/浏览器兼容性靠真机，不在单测覆盖内。

---

## 🧩 BiliKit-Web Core

一个 `.user.js`，页面世界注入（`@grant none`），涵盖多个模块 + 设置面板。首页右下角悬浮齿轮打开面板（装了 Feed 则并入其右下按钮组，心智统一），按模块开关、逐项配置；深浅色跟随系统。

![BiliKit-Web 设置面板](docs/screenshot-core-panel.jpg)

- **CDN 优选** — 把取流重定向到你指定的大陆镜像，绕开海外常被分到的慢节点 / 回源失败节点（HTTP 514）。改写 playurl 并整列重建备份镜像，杜绝主备之间「URL 反复横跳」。只动 upos 系（签名与主机无关、可互换）。面板内可选节点、支持自定义 host。
- **主题同步** — 跟随**系统**深浅色，全站（首页 + 播放页 + 抽屉）**无刷新实时切换**、跨标签页同步。本质是切换 B 站主题样式表 `<link>` 的 href，模仿其原生换肤。面板可选「跟随系统 / 始终深 / 始终浅」。
- **全站打开方式** — 首页、搜索、空间、收藏等浏览页统一选择新标签页（新安装默认）/ 当前页 / 底部抽屉。抽屉同源页的地址栏同步为当前视频，浏览器后退关闭、前进可重开。
- **评论信息** — 在每条评论/回复的姓名右侧显示男/女性别图标、时间旁显示 IP 属地。直读嵌套 Shadow DOM 里的 lit 组件数据，性别与属地共用逐层作用域观察 + rAF 合并，不查用户资料接口，图标复用 B 站自身的缓存静态资源，**替代会把视频页拖到 4GB 内存的第三方「开盒」脚本**。
- **防睡眠** — 播放时申请屏幕常亮、暂停/结束释放；换 P / 播放器重建自动接管。
- **回程** — 视频页左下角「回退栈」胶囊，记住站内连续跳视频的**来时路**，点一下跳回上一个并**续播**（`?t=` 带回离开时的进度）。顶层窗口与 BiliKit-Web 抽屉 iframe 内都生效；Safari 新标签模式另有实验性的“跨视频历史压扁”，使自动打开的子标签可左滑关闭并回到来源页。
- **免登录**（默认关） — 未登录也能看视频/动态下方**评论**、看他人**动态**、看 **1080p** 视频。伪造登录态 + 改写少数接口（nav 认登录、reply 走匿名放行评论、playurl 塞 `qn=80&try_look=1` 重签 wbi 出 1080p），装它即可替代 [beefreely](https://github.com/vruses/beefreely) 等免登录脚本，**根除多个脚本抢改 fetch 导致的时好时坏**。取舍：纯只读（发评论/点赞等需真登录）、看不到评论 IP 属地（「评论信息」里的性别仍可显示）、1080p 上限为官方试看（无 4K/大会员清晰度）、仅未登录时生效。

> **为何对 Safari 关键**：`@grant none` → 注入「页面世界」，才能拦到播放器真正的 fetch、读到 lit 组件实例属性。带 `@grant` 的脚本会被 Safari Userscripts 强制丢进隔离世界，hook 不到、读不到而失效。

## 📺 BiliKit-Web Feed

把首页的 PC 推荐换成**手机 App 的推荐流**（登录后个性化、不重复）。

![BiliKit-Web Feed 首页推荐流](docs/screenshot-feed-home.jpg)

- **零依赖 · 零框架** — 纯手写 TypeScript + 原生 DOM，无 React / Vue / 任何运行时库，整个产物 gzip 约 **30KB**。虚拟化、MSE 预览都是自写，不背通用库的包袱。（对照 [Bilibili-Gate](https://github.com/magicdawn/bilibili-gate) 那类重型 React 首页，虚拟化一关就动辄上 GB 内存）
- **窗口化虚拟化** — 只渲染可视窗口 ± 缓冲的卡片、上下占位撑高，DOM 数量受控；移出时主动释放封面、video、MSE 和 object URL，避免重媒体资源跟随滚动累积。锚点补偿滚动位置，上下翻不抖。
- **卡片** — 封面骨架微光 + 加载完淡入、封面悬停**真视频秒开预览**（见下）、播放/弹幕/时长、UP 头像与名字（点进空间）、推荐理由徽章。
- **封面预览**（面板可选 真视频 / 雪碧图 / 关闭）：**真视频**用 **MSE** 只抓 init + 头几秒分段边播边补，起播接近手机 App 原生（热门冷门都覆盖，靠浏览器 fetch 拿分段、绕开对脚本的反爬）；静音循环、右下角时长转「当前 / 总时长」、内存有界（单卡封顶、滚走即拆）。取流失败自动回退渐进 mp4，再退回雪碧图缩略帧。
- **打开方式**（面板可选）：**新标签页（新安装默认）** / 当前页 / 底部抽屉。
  - **新标签页**：首页完整留在原标签，关掉视频标签即可结束完整播放上下文。Safari 可选实验性的“左滑回到来源页”：只压扁由 BiliKit-Web 自动打开的子标签中的跨视频 SPA 历史；普通标签、当前页和抽屉不受影响。实现取舍见 [Safari 新标签历史压扁](docs/RESEARCH-new-tab-history.md)。
  - **抽屉**：同源 iframe 内嵌播放，从底部上滑、顶部留缝放浮动按钮（新标签 / 关闭），**隐藏站内顶栏 + 去广告**、加载遮罩（封面模糊铺底）、悬停预连接提速、主题跟随宿主；点顶部缝 / 关闭键 / `Esc` 关闭。整个标签页始终至多一个 iframe：关闭时用暂停确认 + 短时防抢播守卫停住媒体并隐藏；打开不同视频时先确认旧播放器已暂停，再在同一 iframe 中整页 `replace` 创建新 Document，避免 B 站视频 SPA 跨视频累积旧应用状态。
  - **当前页**：使用顶层视频页导航以利于浏览器回收完整视频上下文；返回首页时恢复已加载卡片、推荐游标和滚动位置，不从第一页重拉。
- **悬浮工具**：右下角刷新内容 / 返回顶部。

---

## 独立脚本（尚未并入 Core）

这些仍是各自独立的 `.user.js`，按需单独安装：

| 脚本 | 作用 |
|---|---|
| [**浮窗抽屉** · Float](scripts/float.user.js) | 全站点视频 → 页内抽屉播放（多形态、滑动关闭）。注：Core 的**打开方式 / 全站抽屉**已内置同类能力，一般无需再单独装。 |
| [**清晰度自适应** · Adaptive Quality](scripts/quality-watch.user.js) | 替代会卡死的「自动」：稳妥起步、网速好升档、卡顿降档。 |
| [**首页净化** · Home Clean](scripts/home-clean.user.js) | 净化原生首页流：去广告位 + banner、按关键词/UP/播放量过滤（不装 Feed、想留原生首页时用）。 |

> **迁移提示**：Core 已内置 **CDN 优选 / 主题同步 / 评论信息（性别、属地）/ 防睡眠 / 回程 / 全站抽屉（打开方式）**——若你装过这些的旧独立版（含已废弃的独立 **回程**），改装 Core 后即可卸载（脚本内有单例守卫，短期并存不会重复执行，但功能重复）。

## 与其它增强脚本共存

BiliKit-Web Core 的 **CDN 优选 / 免登录** 都在页面世界 hook `fetch`/`XHR`。别的脚本若也 hook 并**改写同一批接口**（`playurl` / `nav` / `reply`），多层叠加的先后顺序不确定 → 常表现为**「时好时坏」**。原则：**优先用 BiliKit-Web 内置的等价功能**；确要共存，就关掉与对方重叠的那个 BiliKit-Web 模块给它让路。

| 同类脚本 | 与 BiliKit-Web 的关系 | 建议 |
|---|---|---|
| [**beefreely**](https://github.com/vruses/beefreely)（免登录看评论 / 1080p） | 功能重叠，且都抢改 `nav`/`reply`/`playurl` → 时好时坏 | 用 Core 的**免登录**替代并卸载它；若坚持同装，关掉 Core 的 **CDN 优选**给它让路 |
| 各类**免登录高清 / 解锁 4K** 响应改写脚本 | 都改写 `playurl` 响应 → 与 **CDN 优选 / 免登录** 互抢 | 二选一，留 BiliKit-Web 的即可 |
| [**Bilibili-Gate**](https://github.com/magicdawn/bilibili-gate)（自定义首页，重型 React） | 与 **Feed** 都接管首页 | 别同时接管，二选一 |
| [**Bilibili-Evolved**](https://github.com/the1812/Bilibili-Evolved)（大型增强套件） | 主题 / 播放 / 净化等多有重叠 | 可共存，但重叠项各留一边，免得双重处理、换肤打架 |
| **自动网页全屏 / 宽屏** 类脚本 | 与「抽屉 · 网页全屏」思路重叠 | 原生播放页可共存；BiliKit-Web 抽屉内已自带，无需 |
| 第三方**评论属地 /「开盒」**脚本 | 与 **评论信息**的属地显示重复，部分还把视频页拖到数 G 内存 | 用 Core 的，卸载第三方 |
| **播放器默认设置**（宽屏 / 倍速 / 快捷键）类 | 一般不碰上述接口，不冲突 | 可共存 |

## 设计取舍备忘

- **抽屉加载完整视频页**（非嵌入播放器）：换来高清 + 评论 + 弹幕齐全，代价是略重；曾试「悬停预热整页」提速但内存过高已回退，仅留零成本的悬停预连接。
- **海外卡顿的根因是回源，不是带宽/IP**：实测边缘节点 9ms 可达，但冷门/新视频在海外节点回源慢甚至失败。解法是把取流指到回源快的大陆镜像，而非优选 IP。选镜像须按真实吞吐实测（见 [`test/`](test/)）。
- **音频/响度均衡不可行**：Safari 上 `createMediaElementSource` 接管 B 站 MSE 视频后 AnalyserNode 读到全零（WebKit 路由 bug）。
- **不合并为单文件**：Core 是页面世界（`@grant none`）、Feed 需隔离世界（`GM.xmlHttpRequest`）——注入世界不同，故拆两个脚本，靠同源 localStorage 共享设置。

## 开发

Vite + [vite-plugin-monkey](https://github.com/lisonge/vite-plugin-monkey) + TypeScript，单仓双产物。

```bash
npm install
npm run build        # 输出 dist/bilikit-core.user.js 与 dist/bilikit-feed.user.js（兼容既有发布地址）
```

## 品牌与许可

BiliKit-Web 与原生客户端 [BiliKit-Mac](https://github.com/shiinayane/BiliKit-Mac) 使用同源的
三层几何标志。Web 图标直接合成原始 SVG，保持透明背景，不包含 Icon Composer 的容器、
Liquid Glass、阴影或其他系统材质。源图层与导出说明见 [`assets/brand/`](assets/brand/)。

源代码及工程文档采用 [MIT License](LICENSE)。BiliKit-Web 名称、Logo 与图标等品牌资产不属于
MIT 授权范围，详见[品牌资产权利声明](BRAND-ASSETS.md)。
