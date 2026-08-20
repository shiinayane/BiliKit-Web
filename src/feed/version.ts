// BiliKit-Web Feed 版本号——单一事实来源（与 Core 的 src/core/version.ts 对称）。
// vite.feed.config.ts 的 `@version` 从这里读；feed.ts 启动时把它写进 localStorage，供 Core 的「关于」页显示。
// 发新版只改这一行。
export const FEED_VERSION = '0.3.23'
