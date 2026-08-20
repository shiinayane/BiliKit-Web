# 首页 → 视频的顶层导航与状态恢复

> 目的：摆脱完整视频 iframe 关闭后仍驻留数百 MB 的生命周期问题，同时避免「当前页打开视频、返回后首页从头加载」的体验倒退。调研与实现日期：2026-07-20。

## 结论

B 站当前并不存在一个能从首页直接调用的全局视频 SPA 入口：

- 原生首页视频卡是普通 `<a target="_blank">`，没有走站内同标签 router；
- 视频页的相关推荐是 Vue 2 `router-link`，由视频页私有的 Vue Router 2.8.1 接管；
- 当前视频包 `video.8df4bfdc8a4ea4283f4cdb56e1d073a7750a1f3f.js` 内部创建了 `mode: "history"` 的 router，只注册 `/video/av:id`、`/video/BV…` 和 PR 视频路由；
- router、Vuex store 与根 Vue 应用都留在 webpack 闭包中，并只在视频页的 `#video-page-app/#app` 上初始化。首页没有同类全局对象或隐藏路由入口。

因此，“首页也调用 B 站 SPA”实际意味着自己实现一层 PJAX：抓视频 HTML、准备 `__INITIAL_STATE__`、重放依赖、创建挂载节点、启动视频 Vue 应用，再负责返回时销毁播放器/observer/样式并恢复首页。它不只是一次 `history.pushState()`。

这条路线没有采用，原因不只是维护成本：它会让首页 Feed 与完整视频应用处于同一个 WebContent 生命周期，极易同时保留两套应用状态；这与本轮“让 Safari 在离开视频后真正释放视频进程”的性能目标相反。仅改 URL 的 `pushState()` 也不可行——它不会凭空渲染视频页。

## 采用的架构

“当前页”模式继续使用真正的顶层导航，但在离开首页前，把以下轻量状态同步写入当前标签页的 `sessionStorage`：

- 当前 App / Web 推荐源；
- Web 推荐的 `fresh_idx` 分页游标；
- 已加载的 `FeedCard[]`（包含去重与“不想看”显示状态）；
- 是否已经耗尽；
- `scrollY`。

返回首页并成功找到原生 Feed 容器后，BiliKit-Web 一次性消费这份快照，先用已有卡片重建窗口化列表，再恢复滚动位置；触底时从保存的游标继续加载。快照只保存 JSON，不保存 DOM、iframe、Vue 实例、observer、MSE、video 或 object URL。

这提供的是“状态连续”，不是伪装成 SPA：

- Safari 仍可让顶层视频页进入独立 WebContent，并在返回后回收；
- 首页重新创建的只有轻量 Feed DOM，卡片窗口化规则不变；
- `sessionStorage` 按标签页隔离，快照一次性消费，24 小时过期；
- 隐私模式或存储配额不足时不阻断导航，只退化为普通当前页往返。

## 代码位置

- `src/feed/return-session.ts`：快照校验、保存、一次性读取；
- `src/feed/feed.ts`：离开前采集状态，接管首页后恢复数据/游标/滚动；
- `src/feed/card.ts`：仅在“当前页”模式真正导航前触发保存；
- `src/feed/return-session.test.ts`：版本、过期、未来时间、损坏数据与数值规范化测试。

## 后续可选研究

若未来仍要验证 PJAX 原型，应放在独立实验分支，并至少测量：切换 10 次后的 WebKit malloc / JS Gigacage / graphics 趋势、旧 Vue 根与播放器是否可达、返回首页后网络与 observer 数量、B 站视频包更新后的失效率。没有这些证据前，不应把私有应用壳注入方案作为正式功能。
