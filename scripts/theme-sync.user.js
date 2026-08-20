// ==UserScript==
// @name         BiliKit-Web · 主题同步
// @name:en      BiliKit-Web · Theme Sync
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.4.9
// @description    ⚠️【已废弃·功能并入 BiliKit-Web Core，请改装 Core】让 B 站跟随系统深浅色，全站无刷新实时切换并同步所有 Tab。
// @description:en Make Bilibili follow the system light/dark theme, switching live across the whole site with no reload and syncing every tab.
// @author       shiinayane
// @match        *://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/573476/B%E7%AB%99%E4%B8%BB%E9%A2%98%E5%90%8C%E6%AD%A5.user.js
// @updateURL https://update.greasyfork.org/scripts/573476/B%E7%AB%99%E4%B8%BB%E9%A2%98%E5%90%8C%E6%AD%A5.meta.js
// ==/UserScript==

/*
 * ⚠️ 已并入 BiliKit-Web Core，建议迁移：本功能已整合进新脚本 BiliKit-Web Core
 * （CDN 优选 + 主题同步 + 评论属地 + 防睡眠 + 统一设置面板），后续更新只在新脚本进行。
 * 安装：https://greasyfork.org/scripts?q=BiliKit-Web
 * 装新版后可卸载本脚本；二者有单例守卫，短期并存不冲突。
 */

/*
 * 原理（实测）：
 * - B 站换肤的本质 = 切换主题样式表 <link> 的 href：
 *     …/bfs/seed/jinkela/short/bili-theme/light.css  ↔  …/dark.css
 *   这张表定义了全站 CSS 变量（--bg1 等），首页与播放页通用，换它即全站(含播放器)瞬间换肤、无刷新。
 * - 同时 toggle <html> 的 bili_dark / night-mode 标记类（部分组件/JS 读取它们）。
 * - theme_style cookie（dark/light）保证新页面/新 Tab 的初始主题。
 * - prefers-color-scheme 的 change 在每个 Tab 各自触发，天然跨 Tab 同步；visibilitychange 兜底冻结 Tab。
 * - 例外通道：部分 Web Component（如评论 <bili-comments>）用自身 reactive 的 theme 属性控制其
 *   Shadow DOM 主题，不读全站 CSS 变量/cookie——换样式表换不动它（表现为「UP主觉得很赞」等组件内
 *   元素不跟随深浅切换）；故额外把这些组件的 .theme 直接设成目标值。
 */
(() => {
  'use strict';

  // 【已并入 BiliKit-Web Core】检测到 Core 在运行则提示本独立脚本可卸载（一次性、可关闭；不影响本脚本功能）。
  if (window.top === window.self) setTimeout(() => {
    try {
      if (Date.now() - (Number(localStorage.getItem('bilikit:alive.core')) || 0) > 15000) return;
      const K = 'bilikit:dismiss.legacy-theme-sync';
      if (localStorage.getItem(K)) return;
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483600;max-width:300px;padding:10px 34px 10px 14px;border-radius:10px;background:rgba(22,23,28,.96);color:#e3e5e7;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      b.innerHTML = '「主题同步」已并入 <b style="color:#fb7299">BiliKit-Web Core</b>，本独立脚本可卸载。<a href="https://github.com/shiinayane/BiliKit-Web" target="_blank" rel="noopener" style="color:#fb7299;text-decoration:none">详情</a>';
      const x = document.createElement('span');
      x.textContent = '✕';
      x.style.cssText = 'position:absolute;top:7px;right:11px;cursor:pointer;opacity:.55';
      x.onclick = () => { try { localStorage.setItem(K, '1'); } catch (e) {} b.remove(); };
      b.appendChild(x);
      (document.body || document.documentElement).appendChild(b);
    } catch (e) {}
  }, 2500);

  // 仅在顶层窗口运行：避免跑进 BiliKit-Web·Float 的抽屉 iframe（其主题由 Float 自行处理）。
  if (window.top !== window.self) return;

  // 单例守卫：防止脚本被重复安装/注入导致重复设 cookie / 重复换肤。
  if (window.__BILIKIT_THEME_SYNC__) return;
  window.__BILIKIT_THEME_SYNC__ = true;

  const COOKIE_NAME = 'theme_style';
  const COOKIE_DOMAIN = '.bilibili.com';
  const THEME_LINK_RE = /\/bili-theme\/(light|dark)\.css/; // 命中主题样式表（不含 light_u.css 等基础表）

  const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const systemDark = () => !!(mql && mql.matches);

  // document.cookie 写入是同步操作，apply() 在每次切回标签页时都会跑，值没变就跳过
  let lastCookieValue = null;
  function setCookie(name, value) {
    if (value === lastCookieValue) return;
    lastCookieValue = value;
    document.cookie = `${name}=${value}; path=/; domain=${COOKIE_DOMAIN}; max-age=31536000; SameSite=Lax`;
  }

  // 切换主题样式表 href（light.css ↔ dark.css）。幂等：href 已正确则不动（不触发重新下载）。
  function swapThemeStylesheet(doc, dark) {
    const want = dark ? '/dark.css' : '/light.css';
    for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
      if (!THEME_LINK_RE.test(link.href)) continue;
      if (!link.href.includes(want)) link.href = link.href.replace(/\/(light|dark)\.css/, want);
    }
  }

  // 让 B 站评论等 Web Component 跟随主题：它们用自身 reactive 的 `theme` 属性控制 Shadow DOM 内主题
  // （如「UP主觉得很赞」标签），不读全站 CSS 变量/cookie——换样式表换不动，必须直接设 .theme。
  // 只在值不符时写，平时近乎零成本，也不与 B 站自己的换肤打架（设成同值它不会反复触发）。
  function syncComponentTheme(dark) {
    const want = dark ? 'dark' : 'light';
    for (const el of document.querySelectorAll('bili-comments')) {
      try { if (el.theme !== want) el.theme = want; } catch (_) {}
    }
  }

  function apply() {
    const dark = systemDark();
    setCookie(COOKIE_NAME, dark ? 'dark' : 'light'); // 持久化：保证后续加载的初始主题
    swapThemeStylesheet(document, dark); // 当前页：无刷新换肤（document-start 时表可能还没插入，由后续时机兜底）
    const root = document.documentElement;
    root.classList.toggle('bili_dark', dark);
    root.classList.toggle('night-mode', dark);
    // 整页加载的首帧在主题表就绪前是白底，深色模式下表现为「闪白」
    // （跨文档回退没命中 bfcache 时尤其明显）；document-start 直接给 <html>
    // 垫上深色底，首帧即深色。浅色模式清掉，不与 B 站自己的背景打架。
    root.style.backgroundColor = dark ? '#18191c' : '';
    syncComponentTheme(dark); // 评论等组件的私有主题通道，单独同步
  }

  apply(); // document-start
  // 主题表通常在 document-start 之后才插入 <head>，故 DOMContentLoaded 再纠正一次（幂等）
  document.addEventListener('DOMContentLoaded', apply);

  // 系统主题变化：每个 Tab 各自触发，天然跨 Tab 同步
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', apply);
    else if (typeof mql.addListener === 'function') mql.addListener(apply); // 旧浏览器回退
  }

  // 兜底：标签页从后台/冻结恢复可见时补一次，处理冻结期间错过的 change 事件
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') apply();
  });

  // 评论宿主懒加载、SPA 换视频后会重建，新元素带的是 B 站自己（可能过期）的主题值；
  // 轻量观察 DOM 增删，有新组件就补设一次（rAF 合并；只在 .theme 不符时才写，平时近乎零成本）。
  let syncPending = 0;
  const scheduleComponentSync = () => {
    if (syncPending) return;
    syncPending = requestAnimationFrame(() => { syncPending = 0; syncComponentTheme(systemDark()); });
  };
  new MutationObserver(scheduleComponentSync).observe(document.documentElement, { childList: true, subtree: true });
})();
