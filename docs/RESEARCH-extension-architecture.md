# BiliKit-Web 跨浏览器扩展架构与迁移路线

> 状态：架构研究稿，尚未开始扩展实现。  
> 调研日期：2026-07-21。  
> 目标平台：Chrome、Edge、Firefox、Safari（macOS，后续可扩展到 iOS/iPadOS）。  
> 本文是后续实现的决策依据；框架/API 版本会变化，真正开工前应复核文末标为“需原型验证”的项目。

## 1. 结论先行

BiliKit-Web 不应维护四套浏览器扩展，也不应把现有用户脚本一次性重写掉。推荐形态是：

> **一套跨浏览器 WebExtension 核心，按浏览器生成独立产物；现有 Core / Feed 用户脚本继续作为兼容发行物，共享纯逻辑与功能控制器。**

当前建议的具体技术选择：

| 范围 | 决策 |
|---|---|
| 扩展构建框架 | **WXT**，固定精确版本后再开始迁移 |
| Manifest | **MV3-first**，四个平台分别生成 manifest，不追求字节级相同 |
| UI 运行时 | 页面增强继续**原生 TypeScript / DOM**；Popup / Options 第一版也先原生，复杂度达到门槛后再局部引入 Preact |
| 页面执行环境 | 隔离世界 content script + 极小的 main-world 注入脚本 |
| 后台 | 以随时终止为前提的事件驱动代码；Chromium 用 Service Worker，Firefox 用非持久 Event Page，Safari 优先 Service Worker |
| 扩展 API | 使用 WXT 的 `browser` Promise API，不同时再装 `webextension-polyfill` |
| 存储 | WXT Storage；普通设置 `sync/local`，标签页会话 `session`（带能力检测/回退），敏感值只放 `local` |
| 消息 | 第一版可用原生消息；跨环境调用变多后采用轻量的 `@webext-core/messaging`，页面世界桥仍自行定义并严格校验 |
| Safari | WXT 生成 WebExtension 目录；macOS 免费临时加载；发布阶段由 Apple packager/Xcode 包装，原生 App 第一版只做最小安装引导 |
| 用户脚本 | 迁移期和可预见的将来都保留；不要求扩展与用户脚本同时安装 |
| 性能原则 | 不把大媒体 `ArrayBuffer` 通过通用 runtime 消息来回复制；Feed 虚拟化、MSE、抽屉生命周期继续由命令式控制器管理 |

WXT 当前面向 Chrome、Firefox、Edge、Safari并支持 MV2/MV3 多目标构建；文件入口、manifest生成、开发重载、Vitest fake browser和Chrome/Firefox/Edge提交均已有正式文档。Safari可生成扩展目录，但原生包装和发布仍需 Apple 工具完成。参见 [WXT 总览](https://wxt.dev/)、[浏览器目标](https://wxt.dev/guide/essentials/target-different-browsers.html) 与 [发布说明](https://wxt.dev/guide/essentials/publishing.html)。

## 2. 为什么现在不能直接开始重写

当前 BiliKit-Web 不是普通的“往网页插几个按钮”：

- Core 必须在页面世界拦截 B 站播放器的 `fetch` / `XMLHttpRequest`，还要读取 lit/Web Component 实例数据；
- Feed 目前依靠 `GM.xmlHttpRequest` 跨域访问 App API 和媒体 Range，运行在隔离世界；
- 抽屉包含 URL/history、iframe nonce、暂停确认、导航竞态、主题镜像和完整视频页的生命周期处理；
- Feed 的虚拟化、MSE/object URL 和媒体释放是手写的性能关键路径；
- Safari 对完整视频 iframe 的 WebCore 对象存在进程级驻留，扩展化本身不会改变这个事实；
- 免登录、CDN响应改写、TV登录/access key等功能还涉及商店权限说明和审核风险。

因此真正的问题不是“怎样把 `.user.js` 改成 `manifest.json`”，而是怎样把现有代码拆成明确的能力边界，同时不丢失页面世界能力、不引入新的媒体复制和生命周期泄漏。

## 3. 目标与非目标

### 3.1 目标

1. Core 与 Feed 在扩展版中成为一次安装、统一版本和统一设置的产品。
2. Chrome、Edge、Firefox、Safari共享绝大多数功能代码，但允许不同构建产物使用不同 manifest 和 adapter。
3. 用户脚本继续可独立构建、发布，不因扩展迁移中断现有用户。
4. 页面增强仍保持低常驻开销；不因扩展化引入大型 UI运行时。
5. 设置从 B 站 origin 的 `localStorage/cookie` 迁移到扩展存储，网页不再能直接读取 access key等敏感值。
6. 后台获得跨域请求、标签页协调、统一存储和DNR能力。
7. 建立可测试的消息协议、manifest快照和四浏览器发布流程。
8. 为将来的轻量播放器预留能力，但不在第一阶段承诺重做播放器、弹幕和评论。

### 3.2 非目标

- 不通过扩展化“宣称修复”Safari iframe内存驻留；严格回收仍需要顶层导航、关闭标签页或改成轻量播放器。
- 不在初期引入React/Vue重写 Feed、抽屉或现有设置面板。
- 不追求一个 manifest 原封不动跑四个浏览器。
- 不追求一次迁移完所有模块。
- 不立即放弃GreasyFork。
- 不把B站远程脚本作为扩展代码执行；MV3要求扩展逻辑随包提交，远程只能提供数据而不能下发可执行逻辑。参见 [Chrome MV3 remote hosted code要求](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) 与 [MV3商店要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)。

## 4. 工具链选型

### 4.1 选择 WXT

选择原因：

- 与当前 Vite + TypeScript 技术栈接近，不强制React/Vue；
- 有明确的 background/content/popup/options/unlisted script入口模型；
- 可按浏览器和MV版本生成独立构建；
- 提供 `injectScript`，适合“隔离世界父脚本 + main-world子脚本”的BiliKit-Web需求；
- 内建统一的Promise风格 `browser` API；
- 内建带类型、watch和migration的Storage；
- 对Vitest提供 `@webext-core/fake-browser`；
- 可自动打包并提交Chrome、Edge、Firefox；
- 框架只留在扩展App边界，业务包可以不依赖WXT，降低锁定风险。

WXT的main-world文档明确指出：直接使用 `world: "MAIN"` 存在浏览器/MV兼容和无法访问扩展API的问题，推荐从隔离世界content script手动注入unlisted script，并在两者之间通信。参见 [WXT Content Scripts：Isolated World vs Main World](https://wxt.dev/guide/essentials/content-scripts.html#isolated-world-vs-main-world)。

### 4.2 暂不选择 Plasmo

Plasmo适合React-first、内容脚本UI较重、希望大量约定式生成的项目，也自带存储/消息和多目标构建。但它对BiliKit-Web的主要价值与WXT重叠，而BiliKit-Web并不需要React-first结构；其官方仓库当前仍将框架标为alpha，且main-world/内容UI抽象对我们最关键的页面hook没有明显优势。参见 [Plasmo官方文档](https://docs.plasmo.com/) 与 [官方仓库](https://github.com/PlasmoHQ/plasmo)。

### 4.3 暂不选择 CRXJS

CRXJS是活跃的Vite插件，适合Chromium MV3和HMR，但官方定位仍以Chrome Extension为核心。BiliKit-Web必须同时覆盖Firefox的Event Page、Safari打包和跨浏览器main-world注入，选择它意味着这些差异继续由项目自己维护。参见 [CRXJS npm说明](https://www.npmjs.com/package/@crxjs/vite-plugin)。

### 4.4 暂不选择 Extension.js

Extension.js 3已能很好地覆盖Chrome、Edge、Firefox，并处理Chromium Service Worker与Firefox Event Page差异；但其CLI当前不支持Safari目标，需要把Safari另接一套构建步骤。Safari是BiliKit-Web的首要平台，因此不如WXT匹配。参见 [Extension.js浏览器支持](https://extension.js.org/docs/browsers/browsers-available)。

### 4.5 不直接手写 Vite + 四套 manifest

这条路线控制力最高，但会把时间消耗在：

- background字段差异；
- CSP和web accessible resources；
- Firefox `gecko.id`与source package；
- Safari packager输入；
- 浏览器启动/重载；
- 多商店zip和提交；
- manifest权限漂移。

只有当WXT的main-world注入或构建结果在原型阶段被证明无法满足BiliKit-Web时，才退回低层构建。

## 5. UI框架决策

### 5.1 第一版仍然无UI运行时

WXT是构建框架，不是必须随页面运行的UI框架。第一版建议：

| 表面 | 方案 |
|---|---|
| main-world hook | 原生TypeScript |
| content script生命周期 | 原生TypeScript |
| Feed、虚拟化、MSE、抽屉 | 保留原生DOM和现有控制器 |
| 评论图标、主题、唤醒、回程 | 原生DOM |
| Popup | 原生HTML/CSS/TypeScript |
| Options | 第一版原生HTML/CSS/TypeScript |
| Safari容器App | 最小SwiftUI安装引导，仅Safari使用 |

原因不是“框架几KB会导致2GB内存”，而是现有页面功能需要精确控制B站DOM、媒体节点和卸载时机；把它们改写为虚拟DOM不会解决WebKit驻留，反而扩大回归面。

### 5.2 何时允许引入 Preact

满足任一条件时，允许只在扩展自有页面引入Preact：

- Popup/Options出现三个以上共享复杂组件；
- 权限、异步状态、错误状态和表单验证已使手动DOM同步明显重复；
- 轻量播放器的自有UI进入实现阶段；
- 原生实现的UI测试成本已高于引入框架的成本。

即使引入，也只允许进入完全由扩展拥有的Popup、Options或隔离Shadow Root；MSE、video、虚拟化和iframe控制器仍保持命令式TypeScript。

## 6. 运行时架构

```text
┌──────────────────────────────────────────────────────────────┐
│ B站页面世界                                                  │
│ page-main：fetch/XHR、lit实例、播放器对象、站点路由           │
└───────────────────────────┬──────────────────────────────────┘
                            │ 受限、可验证、无敏感数据的页面桥
┌───────────────────────────▼──────────────────────────────────┐
│ 隔离世界 Content Script                                     │
│ DOM/UI、Feed、抽屉宿主、生命周期、extension runtime通信       │
└───────────────────────────┬──────────────────────────────────┘
                            │ runtime messaging
┌───────────────────────────▼──────────────────────────────────┐
│ Background                                                   │
│ 跨域API、标签页协调、存储、权限、DNR、会话控制               │
└───────────────┬───────────────────────────┬──────────────────┘
                │                           │
     ┌──────────▼─────────┐       ┌─────────▼────────────────┐
     │ Popup / Options    │       │ Safari Native Messaging │
     │ 快捷/完整设置      │       │ 后续可选，不是第一阶段  │
     └────────────────────┘       └──────────────────────────┘
```

### 6.1 Main-world脚本

只允许放必须读取或改写页面JavaScript的逻辑：

- CDN与免登录的 `fetch/XHR` 包装；
- `window.__playinfo__`等页面对象；
- lit/Web Component实例数据；
- B站播放器与SPA内部导航观测；
- 抽屉子文档的暂停、replace和握手。

禁止放入：

- access key；
- 扩展设置全量；
- tabs/cookies/storage等扩展API；
- 任意可以让页面要求后台读取别的标签页、任意URL或敏感数据的接口。

MAIN world与页面没有隔离，页面可以观察、调用和干扰其中的代码，而且MAIN world脚本不能使用扩展专属API。参见 [MDN ExecutionWorld](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld)。因此页面桥不是安全边界，nonce只能拒绝过期文档，不能把页面变成可信调用者。

### 6.2 Content Script

负责：

- DOM读写和UI挂载；
- 页面世界脚本注入；
- 对页面桥消息进行类型、字段、来源和当前Document校验；
- 将允许的请求转换为runtime消息；
- 响应扩展设置变化；
- 在扩展更新、卸载或上下文失效时清理observer、事件和媒体资源；
- SPA路径变化后的幂等重挂载。

Content script能访问DOM，但默认看不到页面JavaScript变量；Firefox还有Xray wrapper差异。不要让功能代码依赖某浏览器“恰好能透过去”的对象行为。参见 [MDN Content Scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)。

### 6.3 Background

负责：

- App/Web推荐API；
- 需要host permission的跨域请求；
- 标签页查询、聚焦、暂停、复用和关闭；
- 设置、版本、迁移和权限状态；
- DNR静态/动态规则；
- Popup/Options数据；
- 可选的托管顶层播放器标签。

后台必须按“事件发生时启动、完成后可立即销毁”编写：

- 监听器在入口初始化阶段同步注册；
- 不把Map/变量当持久真相源；
- 状态进入storage，短任务可用内存缓存但必须可重建；
- 不用`window`、DOM、`localStorage`；
- 周期任务使用alarms；
- 每个消息处理器都可重复执行或有幂等键；
- 长任务用明确的超时、AbortSignal和持久状态机。

Chrome MV3要求Service Worker；Firefox当前MV3使用非持久Event Page而不支持`background.service_worker`；Safari同时支持两类环境，并建议为跨浏览器兼容优先Service Worker。参见 [Chrome Service Worker迁移](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)、[Firefox background清单](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) 和 [Safari优化建议](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari)。

### 6.4 Popup与Options

扩展版移除网页右下角设置齿轮：

- Popup：当前标签状态、总开关、打开方式、CDN快速选择、播放控制、打开完整设置；
- Options：access key、CDN测速/自定义节点、全部模块开关、导入导出、诊断和权限说明；
- 用户脚本版继续保留现有网页设置面板。

Popup和Options只通过storage/background使用能力，不直接耦合B站页面DOM。

## 7. 浏览器构建矩阵

统一采用MV3代码模型，但不要求相同manifest：

| 平台 | 后台 | 包/商店 | 关键差异 |
|---|---|---|---|
| Chrome | `background.service_worker` | ZIP / Chrome Web Store | MV3、DNR、禁止远程代码 |
| Edge | Chromium Service Worker | 可复用Chrome ZIP或单独Edge ZIP | API大体与Chrome兼容，商店元数据/审核独立 |
| Firefox | `background.scripts`非持久Event Page | ZIP/XPI + source ZIP / AMO | 必须配置Gecko ID；构建产物需可复现；API行为与Chromium有差异 |
| Safari | 优先Service Worker | WebExtension目录 → Apple packager/Xcode/App Store | 网站访问需用户授权；DNR重定向/改header要求额外权限；原生包装独立 |

WXT默认可能为Safari/Firefox选择MV2；BiliKit-Web应显式构建MV3，并在原型阶段验证生成的background字段和main-world注入时序。若框架在特定目标生成不正确，使用WXT的per-browser manifest函数或hook修正，而不是在运行时堆浏览器判断。

Edge官方说明Chrome扩展API和manifest大体代码兼容，但少数API仍需核对，且应在Edge中实际侧载验证。参见 [Microsoft移植说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/port-chrome-extension) 与 [API支持表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)。

## 8. 建议的仓库结构

第一阶段不要拆成几十个小包，使用四个清晰边界即可：

```text
BiliKit-Web/
├─ apps/
│  ├─ extension/
│  │  ├─ src/
│  │  │  ├─ entrypoints/
│  │  │  │  ├─ background.ts
│  │  │  │  ├─ bilibili.content.ts
│  │  │  │  ├─ bilibili-main-world.ts
│  │  │  │  ├─ popup/
│  │  │  │  └─ options/
│  │  │  ├─ adapters/
│  │  │  └─ app.config.ts
│  │  ├─ public/
│  │  ├─ wxt.config.ts
│  │  └─ web-ext.config.ts
│  │
│  ├─ userscripts/
│  │  ├─ entry-core.ts
│  │  ├─ entry-feed.ts
│  │  ├─ adapters/
│  │  └─ vite.*.config.ts
│  │
│  └─ safari-wrapper/          # 原型期可不创建；需要Native Messaging/发布时再加入
│
├─ packages/
│  ├─ shared/                  # 纯逻辑：URL、签名、schema、状态机、协议
│  └─ features/                # 功能控制器，通过capabilities使用平台能力
│
├─ tests/
│  ├─ manifests/
│  ├─ contracts/
│  └─ e2e/
│
├─ docs/
├─ package.json
└─ pnpm-workspace.yaml
```

初期不引入Turbo/Nx。pnpm workspace和普通npm scripts足够；只有当多包构建时间、缓存或发布依赖图确实成为问题时再加任务编排器。

### 8.1 依赖方向

```text
apps/extension ─┐
                ├──> packages/features ──> packages/shared
apps/userscripts┘

packages/shared/features 不能反向import WXT、GM或具体浏览器API。
```

### 8.2 Capabilities接口

功能代码不再直接调用 `GM.xmlHttpRequest`、`browser.tabs`或`localStorage`：

```ts
export interface BiliKitRuntime {
  storage: SettingsStorage
  network: NetworkClient
  tabs: TabCoordinator
  permissions: PermissionService
  media: MediaTransport
}
```

扩展和用户脚本分别实现：

```text
ExtensionStorage       / UserscriptStorage
BackgroundNetwork      / GMNetwork
ExtensionTabs          / WindowNavigation
ExtensionPermissions   / AlwaysAvailablePermissions
ExtensionMediaTransport/ GMMediaTransport
```

并不是所有旧代码都必须抽象：纯DOM模块若只在content/page环境运行，可以继续使用DOM；只有平台权限、存储、网络和标签页能力需要adapter。

## 9. 消息协议与安全边界

存在两种完全不同的消息通道，不能混用信任模型。

### 9.1 Page ↔ Content

页面本身可以伪造任何 `postMessage` / CustomEvent，因此：

- 使用固定、短小、版本化的消息联合类型；
- 对所有字段做运行时校验，不能只依赖TypeScript；
- 限制URL为已知B站协议和host；
- 不接受“任意fetch URL”“读取任意storage key”“执行任意代码”等泛化消息；
- nonce只用于Document世代/竞态，不作为授权令牌；
- access key、cookie值和完整设置永不经过页面桥；
- 对过大消息设置尺寸上限；
- 页面销毁时撤销监听。

### 9.2 Content/Popup/Options ↔ Background

此通道由扩展runtime提供，但仍需：

- 验证 `sender.tab?.url`、frameId和目标host；
- 为请求设置Abort/timeout；
- 明确错误联合类型，不把原始异常/敏感响应直接发回页面；
- 对写设置、关标签等操作使用幂等ID；
- 大媒体数据不走普通JSON RPC。

WXT列出的轻量、类型安全选择是 `@webext-core/messaging`；是否引入应在第二阶段按消息数量决定，避免为只有两三个消息提前加抽象。参见 [WXT Messaging](https://wxt.dev/guide/essentials/messaging)。

## 10. 存储模型与迁移

### 10.1 扩展版存储分区

| 数据 | 建议位置 | 原因 |
|---|---|---|
| 普通用户偏好 | `storage.sync`，若平台/配额不可用则回退local | 跨设备体验；必须控制体积 |
| access key、登录辅助状态 | `storage.local` | 不进入页面origin，也不跨设备默认同步 |
| 规则缓存、测速结果 | `storage.local` | 设备和网络相关 |
| 当前标签会话、临时nonce | `storage.session`或内存+TTL local回退 | 浏览器会话级；需能力检测 |
| Feed当前页返回快照 | 继续页面 `sessionStorage` | 与具体标签/页面导航绑定，已验证逻辑可复用 |
| UI即时状态 | 当前Popup/Options内存 | 关闭即可丢弃 |

WXT Storage支持`local/sync/session/managed`前缀、类型、watch和版本迁移，可减少手写key和迁移遗漏。参见 [WXT Storage](https://wxt.dev/storage)。

### 10.2 从用户脚本迁移

扩展首次获得 `bilibili.com` 权限后，可以提供显式迁移：

1. content script读取旧 `bilikit:settings`；
2. 校验schema与版本；
3. 只把已知key写入扩展storage；
4. access key单独确认并写入local；
5. 默认不删除旧数据，避免破坏仍在使用的用户脚本；
6. 明确提示不要同时启用扩展和同功能用户脚本；
7. 后续可提供“迁移并停用旧脚本”的操作说明，但扩展无法替用户卸载Userscripts条目。

## 11. 权限策略

原则是只请求当前功能必需权限，绝不使用 `<all_urls>` 预留未来能力。Chrome和Safari都要求最小权限；Safari还会让用户按站点/时间授权。参见 [Chrome权限说明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) 与 [Safari权限说明](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)。

第一版候选：

```text
required host:
  https://*.bilibili.com/*

optional host（按功能启用时申请）:
  App/API host
  实际使用的UPOS/CDN host

permissions（需原型后最小化）:
  storage
  alarms（若确有周期任务）
  declarativeNetRequest / declarativeNetRequestWithHostAccess（启用网络规则时）
  tabs或activeTab（按全局播放器协调需求验证）
```

待验证问题：

- App/API host能否作为required而不造成过宽警告；
- CDN host集合是否应全部optional；
- 不申请`tabs`时，凭B站host permission能否完成所需查询和消息；
- 是否真的需要`cookies`，还是继续由页面逻辑处理可见cookie、后台只保存扩展设置；
- Safari DNR重定向要求源/目标两侧网站权限，对自定义CDN的交互应如何设计。

Safari支持DNR的block/allow/redirect/modifyHeaders等动作，但redirect与modifyHeaders有额外权限和版本要求。参见 [Safari DNR](https://developer.apple.com/documentation/safariservices/blocking-content-with-your-safari-web-extension)。

## 12. 功能放置建议

| 当前模块 | 扩展位置 | 备注 |
|---|---|---|
| theme-sync | Content为主，必要cookie操作经受控main-world | 适合作为首个纵向切片 |
| comment-location | Content观察DOM + main-world读取lit数据 | 先验证Firefox Xray/Safari隔离差异 |
| wake-lock | Content/page文档 | 不需要后台 |
| way-back | Content + session状态 | 可迁移到扩展storage但不急 |
| settings/panel | Popup/Options；用户脚本保留网页Panel | 扩展页面不再显示齿轮 |
| Feed DOM/虚拟化 | Content | 保留原生DOM |
| Feed App API | Background | 替代GM请求 |
| MSE hover preview | Content + 专用MediaTransport | 不走通用消息复制大buffer |
| site drawer | Content宿主 + main-world子页桥 | 保留现有nonce/暂停/replace状态机 |
| CDN pick | DNR实验 + main-world响应改写兜底 | DNR不能任意改JSON响应体 |
| no-login | main-world + Background有限请求 | 商店政策风险单独审查，不应成为首发阻塞项 |
| TV login/access key | Popup/Options + Background | 需要隐私说明和敏感值存储设计 |

## 13. 媒体与内存的特殊约束

### 13.1 不通过runtime消息搬运大媒体

当前Feed只拉init和少数Range分段。扩展版最直接的实现是Background fetch `ArrayBuffer`再发给Content，但不同浏览器的消息序列化/structured clone可能复制数据并抬高峰值。

因此必须做独立原型，对比：

1. Background fetch → runtime message → Content；
2. DNR/响应头策略后由Content直接fetch；
3. 继续由页面上下文直接fetch可访问资源；
4. 浏览器特定fallback。

记录首帧时间、累计字节、消息往返、JS堆和进程footprint。没有数据前不选最终MediaTransport。

### 13.2 扩展不会自动解决完整iframe驻留

扩展仍使用同一个Safari/WebKit引擎：

- 复用/重建iframe不能保证旧WebCore对象立即释放；
- Service Worker不会替页面进程回收Document；
- DNR也不会让完整视频Vue应用变轻；
- 真正可严格释放的已知路径仍是结束对应顶层WebContent（关闭/轮换标签），或不加载完整视频页。

扩展带来的新能力是：后台可以把“托管顶层播放器标签、恢复状态、关闭旧标签”自动化；长期还可以实现只加载video/弹幕/精简评论的轻量播放器。

## 14. 商店与产品风险

### 14.1 单一用途与隐私

四家商店都需要清楚说明扩展用途和权限。BiliKit-Web应使用一个明确目的：

> 改善Bilibili网页的推荐、播放和浏览体验。

Chrome要求只申请最窄权限，并在处理用户数据时提供准确隐私政策；Edge提交也要求解释权限、远程代码和数据实践。参见 [Chrome Web Store政策](https://developer.chrome.com/docs/webstore/program-policies/policies) 与 [Edge发布说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。

默认建议：

- 无遥测、无自建服务器；
- 所有B站数据只在用户浏览器与B站服务器之间流动；
- 不上传浏览历史、access key、cookie、评论或推荐数据；
- 隐私政策把每个host permission与功能一一对应；
- 诊断导出由用户主动保存本地；
- 若未来加入崩溃统计，必须另行设计显式同意。

### 14.2 高风险功能分层

首个商店版本不应被最难审核的功能绑架。建议构建能力层：

```text
store-stable：主题、评论信息、Feed、抽屉、回程、唤醒、设置
store-review：CDN重定向、TV登录/access key
experimental/userscript：免登录响应伪装等需额外政策判断的功能
```

这不是预先认定功能违规，而是降低第一次审核失败的定位成本。是否进入商店包应在提交前按各商店最新政策重新审查。

### 14.3 Firefox可复现构建

Firefox正式安装需要Mozilla签名；使用bundler/minifier时需要提交对应源码和清晰构建说明，依赖应由官方包管理器获取。WXT能生成Firefox sources ZIP，但发布前必须人工检查内容。参见 [Firefox签名与分发](https://extensionworkshop.com/documentation/publish/)、[源码提交](https://extensionworkshop.com/documentation/publish/source-code-submission/) 与 [WXT发布说明](https://wxt.dev/guide/essentials/publishing.html#firefox-addon-store)。

## 15. Safari包装与测试

### 15.1 免费开发阶段

- WXT生成Safari目录后，macOS Safari可以临时加载扩展目录；
- 临时扩展在退出Safari或24小时后移除；
- 也可用Xcode `Sign to Run Locally`、`Team: None`，但重启Safari后需要重新允许未签名扩展；
- iOS模拟器可免费测试；
- iPhone/iPad真机测试、TestFlight和App Store需要Apple Developer Program。

参见 [Apple运行与测试Safari Web Extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)。

### 15.2 发布阶段

WXT不创建Safari原生包装。使用：

```bash
xcrun safari-web-extension-packager path/to/safari-output
```

生成macOS/iOS App与Safari Web Extension目标。只有需要Native Messaging或原生功能时才修改Swift代码；否则容器App维持最小安装/启用说明。参见 [Apple Safari Web Extension Packager](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)。

生成的扩展Resources不应手工维护两份：构建脚本负责把WXT Safari产物同步进Xcode目标，Xcode工程只保存包装、签名、图标和原生代码。

## 16. 测试策略

### 16.1 单元测试

保留现有Vitest纯逻辑测试，并增加：

- storage schema和migration；
- typed message validator；
- capabilities contract；
- manifest生成快照；
- platform feature flags；
- URL/host permission边界。

WXT对Vitest提供first-class插件和内存fake browser，可模拟storage等API。参见 [WXT Unit Testing](https://wxt.dev/guide/essentials/unit-testing)。

### 16.2 构建门禁

CI每次至少生成：

```text
chrome-mv3
edge-mv3（若与Chrome完全相同可验证后复用zip）
firefox-mv3 + sources
safari-mv3目录
bilikit-core.user.js
bilikit-feed.user.js
```

检查：

- manifest schema和浏览器特定字段；
- host/optional permissions快照；
- CSP与web accessible resources；
- 禁止远程JS/WASM逻辑；
- 产物中不含source map、测试数据、access key或本机路径；
- Firefox source ZIP可在干净环境复建同等产物；
- Safari packager能接受目录。

### 16.3 浏览器集成测试

自动化不应假设四浏览器API完全一致：

- Chrome：自动加载unpacked，覆盖background/content/popup/storage；
- Edge：至少对发布候选包做冒烟，不能只因Chromium就跳过；
- Firefox：用临时扩展/web-ext验证Event Page、权限和main-world桥；
- Safari：macOS临时扩展真机检查；iOS先模拟器，真机放到付费计划后；
- B站真实站点：仍需人工回归DOM、播放器、评论、SPA和权限交互。

### 16.4 性能回归

每个重要阶段保留相同操作脚本：

- 首页静置；
- 滚动Feed并触发预览；
- 连续打开10/15个视频；
- 关闭抽屉后等待；
- 当前页往返；
- 原生B站、用户脚本版、扩展版三组对照。

记录DOM/video/objectURL/iframe代理指标和浏览器进程footprint。不能用一次峰值判断回归。

## 17. 发布与版本

### 17.1 产物

```text
artifacts/
├─ bilikit-{version}-chrome.zip
├─ bilikit-{version}-edge.zip       # 若与Chrome相同可复用，但名称/校验独立
├─ bilikit-{version}-firefox.zip
├─ bilikit-{version}-firefox-sources.zip
├─ bilikit-{version}-safari-mv3/
├─ bilikit-core.user.js
└─ bilikit-feed.user.js
```

### 17.2 版本策略

- 扩展使用一个产品版本；
- Chrome/Edge/Firefox/Safari同一功能提交保持同版本号；
- 迁移期Core/Feed用户脚本可保留自己的组件版本，但changelog标注对应扩展版本；
- 所有商店版本号使用最多四段纯数字，避免Firefox格式差异；
- 一个文件作为版本真相源，由构建生成manifest/userscript metadata；
- 第一次商店创建仍需手工，稳定后WXT自动提交Chrome/Edge/Firefox；Safari另走Apple流程。

## 18. 分阶段落地

### Phase 0：只建实验骨架，不迁功能

目标：证明工具链和运行边界，而非提供可用产品。

交付：

- `apps/extension` WXT工程；
- 四浏览器MV3构建；
- Popup显示当前tab和一个测试设置；
- Background、Content、Main-world三段握手；
- manifest快照；
- macOS Safari临时加载说明。

退出条件：四个目标可构建；Chrome/Firefox/Safari能在B站document_start稳定握手；不改现有用户脚本行为。

### Phase 1：设置与一个低风险纵向切片

选择theme-sync或wake-lock：

- Popup/Options写扩展storage；
- Content实时watch设置；
- 功能可开关；
- 用户脚本继续使用旧adapter；
- 验证扩展更新/禁用后的清理。

退出条件：一个功能在四浏览器和用户脚本共用控制器，测试覆盖存储与生命周期。

### Phase 2：页面世界桥与评论信息

- 提取受限协议；
- main-world读取lit数据；
- Content注入UI；
- 楼中楼、SPA、Shadow DOM四浏览器回归；
- 安全审查桥消息。

退出条件：不暴露敏感数据；不同浏览器的隔离/Xray行为均有真机证据。

### Phase 3：Feed与后台网络

- App API从GM迁到Background；
- Feed DOM/虚拟化保持原实现；
- access key移到local storage；
- 完成设置迁移工具；
- 做JSON请求性能对照。

退出条件：Feed功能等价，用户脚本版不回归，后台休眠/重启后状态正确。

### Phase 4：媒体预览专用通道

- 完成四种MediaTransport原型；
- 选择最低复制/最低峰值方案；
- 保持objectURL、MSE和Range清理测试；
- Safari/Chrome分别跑内存A/B。

退出条件：首帧和内存不劣于当前GM路径的可接受阈值。

### Phase 5：抽屉与标签页协调

- 迁移现有抽屉状态机，不改语义；
- Background提供全局暂停/标签页协调；
- 研究托管顶层播放器标签；
- 重跑15视频内存测试和双声竞态。

退出条件：URL/history、Esc、暂停确认、replace、nonce和Forward回归全部通过；不宣称iframe驻留已消失。

### Phase 6：网络改写与审核风险功能

- DNR CDN重定向原型；
- main-world JSON响应改写兜底；
- no-login/CDN/TV登录逐项做权限、隐私和商店政策审查；
- 决定store-stable与userscript-only功能表。

退出条件：每个权限都有用户可理解的用途；商店包没有不必要的高风险功能。

### Phase 7：发行迁移

- 商店素材、隐私政策、安装/迁移文档；
- Chrome/Edge/Firefox首发；
- Safari免费本地测试稳定后再决定付费真机/TestFlight/App Store；
- GreasyFork继续发布，README明确两种安装方式和不能同时启用。

## 19. 开工前必须完成的原型

这些问题任何一个失败，都可能改变架构，不应留到全面迁移后再发现。

### P0：document_start main-world时序

验证Chrome、Edge、Firefox、Safari：

- Content在`document_start`运行；
- WXT `injectScript`能在B站首批关键fetch/XHR之前安装hook；
- CSP不会拦截扩展资源；
- iframe/allFrames和SPA导航行为明确；
- 扩展热更新/禁用后旧脚本不会重复存活。

### P0：后台生命周期

- Chromium Service Worker休眠后消息能唤醒；
- Firefox Event Page重建后状态能恢复；
- Safari后台行为不依赖持续计时器；
- 长请求被终止时可重试/取消。

### P0：媒体二进制传输

用相同视频分段比较Background消息、DNR后直取和现有GM路径，记录真实内存与首帧。

### P0：最小权限

分别侧载四浏览器，记录安装警告、站点授权、optional host请求和DNR重定向体验；据此确定最终manifest。

### P1：商店功能审查

在正式提交前按最新政策逐项评估：CDN、TV登录/access key、免登录。不要用2026-07-21的本文代替提交时的政策复核。

## 20. 已接受、暂定与拒绝的决策

### 已接受

- 单仓库、多目标构建；
- WXT作为扩展构建层；
- MV3-first、浏览器专属manifest；
- main-world与isolated content分离；
- 后台无DOM、可随时重建；
- 页面功能保持原生DOM；
- 扩展设置迁到Popup/Options；
- 用户脚本继续保留；
- 不把完整视频iframe内存问题包装成扩展化收益。

### 暂定，需原型

- `@webext-core/messaging`；
- `storage.sync/session`的最终使用范围；
- Preact只用于复杂的扩展自有UI；
- DNR承担多少CDN逻辑；
- MediaTransport具体实现；
- 托管顶层播放器标签；
- store-stable功能集合。

### 已拒绝

- 四套代码库；
- 一次性重写所有功能；
- 全项目React/Vue化；
- 在main-world暴露通用后台RPC；
- 用runtime消息无界传输媒体分段；
- 为未来能力预先申请`<all_urls>`；
- 第一阶段就做SwiftUI完整设置中心；
- 扩展首发即停止用户脚本维护。

## 21. 何时可以正式开始迁移

满足以下条件后，才从研究进入实现：

1. 本文的架构边界获得确认；
2. 单独分支完成Phase 0；
3. P0四项原型有可复现实测记录；
4. WXT精确版本和Node/pnpm版本锁定；
5. 四份manifest权限快照确定；
6. 用户脚本兼容策略和设置迁移策略确定；
7. CI能同时验证旧产物和扩展骨架；
8. 没有把现有未提交的抽屉/内存改动混入架构迁移。

## 22. 主要参考资料

### 跨浏览器与WXT

- [WXT](https://wxt.dev/)
- [WXT浏览器目标与MV版本](https://wxt.dev/guide/essentials/target-different-browsers.html)
- [WXT Entrypoints](https://wxt.dev/guide/essentials/entrypoints)
- [WXT Content Scripts与main-world注入](https://wxt.dev/guide/essentials/content-scripts.html)
- [WXT Storage](https://wxt.dev/storage)
- [WXT Messaging](https://wxt.dev/guide/essentials/messaging)
- [WXT Unit Testing](https://wxt.dev/guide/essentials/unit-testing)
- [WXT Publishing](https://wxt.dev/guide/essentials/publishing.html)

### 浏览器平台

- [Chrome Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Chrome Service Worker迁移](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)
- [Chrome权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Firefox跨浏览器扩展指南](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension)
- [Firefox background差异](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Firefox Content Scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- [Edge从Chrome移植](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/port-chrome-extension)
- [Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
- [Safari运行与测试](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- [Safari打包](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Safari权限](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
- [Safari DNR](https://developer.apple.com/documentation/safariservices/blocking-content-with-your-safari-web-extension)

### 发布与审核

- [Chrome Web Store政策](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Firefox签名与分发](https://extensionworkshop.com/documentation/publish/)
- [Firefox源码提交](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Edge发布](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
