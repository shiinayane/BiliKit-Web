import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'
import { VERSION } from './src/core/version'
import { ICON } from './icon'

// BiliKit-Web Core：@grant none（页面世界）——所有增强模块 + 统一设置面板打进一个 .user.js。
// 不使用任何 GM_* API，vite-plugin-monkey 会自动输出 `// @grant none`，从而在 Safari
// Userscripts 下注入页面世界（评论信息/CDN 优选/回程/主题同步等模块读页面 JS 的前提）。
// App 推荐 feed 需要 GM.xmlHttpRequest（隔离世界），将来单独一个入口/产物，勿并入本包。
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/entry-core.ts',
      userscript: {
        name: 'BiliKit-Web Core',
        namespace: 'https://github.com/shiinayane/BiliKit-Web',
        version: VERSION,
        description: 'B 站体验增强核心，一装到位：CDN 优选（救海外卡顿）· 免登录看评论/动态/1080p · 主题跟随系统深浅 · 评论显性别/IP 属地 · 播放不息屏——统一设置面板集中开关。Safari 友好、无需扩展、零外部依赖。',
        author: 'shiinayane',
        license: 'MIT',
        icon: ICON,
        // 全站匹配：theme-sync 本就全站换肤，cdn-pick 需覆盖 player.bilibili.com；
        // 其余模块靠自身 observer/轮询自适配页面类型，非相关页自动 no-op。
        match: [
          '*://*.bilibili.com/*',
        ],
        'run-at': 'document-start',
        // 显式 @grant none —— Safari Userscripts 据此把脚本注入「页面世界」，
        // 是评论信息/CDN 优选/回程/主题同步等模块读写页面 JS 的前提。缺了它 monkey 不会输出该行。
        grant: 'none',
      },
      build: {
        // 保留既有发布文件名：GreasyFork 同步地址与已安装脚本的更新链依赖这个稳定路径。
        fileName: 'bilikit-core.user.js',
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false, // 别清空 dist/：与 Feed 产物同放一处，单跑 build:core 不应删掉 bilikit-feed.user.js
  },
})
