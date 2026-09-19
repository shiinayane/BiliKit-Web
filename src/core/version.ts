// BiliKit-Web Core 版本号——单一事实来源。
// vite.config.ts 的 userscript `@version` 与设置面板「关于」页都从这里读，避免两处各写一份、发版时漏改一处。
// 发新版只改这一行。（Core @grant none 无 GM_info，运行时拿不到版本，故用编译期常量。）
export const VERSION = '0.5.34'
