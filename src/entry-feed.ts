import { mountFeed } from './feed/feed'

// BiliKit-Web Feed 入口（隔离世界，@grant GM.xmlHttpRequest）。
// 只做一件事：在首页用 App 推荐流接管原生流（拉 app.bilibili.com 需 GM 跨域）。
// 登录（TV 扫码取 access_key）已移到 Core 页面世界——passport 允许带凭据 CORS，且正常浏览器
// 请求过 SEC 风控，GM 后台请求会被 412（详见 docs/RESEARCH-feed.md 与实测）。
// Feed 只读 bilikit:settings 里的 feed.accessKey 用于拉流；设置由 Core 面板统一管理。
mountFeed()
