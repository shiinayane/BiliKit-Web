import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'
import { FEED_VERSION } from './src/feed/version'
import { ICON } from './icon'

// BiliKit-Web Feed：App 推荐 feed（把手机 App 的推荐流搬上首页）。
// 需 GM.xmlHttpRequest 跨域拉 app.bilibili.com → Safari 下会被注入「隔离世界」，
// 所以与 Core（@grant none 页面世界）拆成两个脚本；两者同源、靠 localStorage 共享设置。
// 详见 docs/RESEARCH-feed.md。
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/entry-feed.ts',
      userscript: {
        name: 'BiliKit-Web Feed',
        namespace: 'https://github.com/shiinayane/BiliKit-Web',
        version: FEED_VERSION,
        description: 'B 站首页换成手机 App 的个性化推荐流。零框架纯原生实现（无 React/Vue、gzip 约 30KB）+ 窗口化虚拟化，约束 DOM、封面与预览媒体的常驻资源。视频默认开新标签页，也可选当前页或底部抽屉；封面悬停「真视频」秒开预览（MSE，接近原生 App）。需配合 BiliKit-Web Core（登录 / 设置）。',
        author: 'shiinayane',
        license: 'MIT',
        icon: ICON,
        // 只接管首页；登录已移到 Core，Feed 不再需要全站注入，也不碰 passport
        match: [
          '*://www.bilibili.com/',
          '*://www.bilibili.com/?*',
          '*://www.bilibili.com/index.html*',
        ],
        connect: ['app.bilibili.com', 'api.bilibili.com'], // app=推荐流；api=hover 预览的 videoshot 雪碧图
        grant: ['GM.xmlHttpRequest', 'GM_xmlhttpRequest'],
        'run-at': 'document-idle',
      },
      build: {
        // 保留既有发布文件名：GreasyFork 同步地址与已安装脚本的更新链依赖这个稳定路径。
        fileName: 'bilikit-feed.user.js',
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false, // 别清掉 Core 的产物（两个脚本同放 dist/）
  },
})
