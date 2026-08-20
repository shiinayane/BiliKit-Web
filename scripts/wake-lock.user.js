// ==UserScript==
// @name         BiliKit-Web · 防睡眠
// @name:en      BiliKit-Web · Wake Lock
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.2.6
// @description    ⚠️【已废弃·功能并入 BiliKit-Web Core，请改装 Core】防止使用 Safari 在 B 站播放视频时休眠或睡眠。
// @description:en Keep Safari from sleeping while playing a Bilibili video.
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/cheese/play/*
// @match        *://www.bilibili.com/festival/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/573479/%E9%98%B2%E6%AD%A2B%E7%AB%99%E7%9D%A1%E7%9C%A0.user.js
// @updateURL https://update.greasyfork.org/scripts/573479/%E9%98%B2%E6%AD%A2B%E7%AB%99%E7%9D%A1%E7%9C%A0.meta.js
// ==/UserScript==

/*
 * ⚠️ 已并入 BiliKit-Web Core，建议迁移：本功能已整合进新脚本 BiliKit-Web Core
 * （CDN 优选 + 主题同步 + 评论属地 + 防睡眠 + 统一设置面板），后续更新只在新脚本进行。
 * 安装：https://greasyfork.org/scripts?q=BiliKit-Web
 * 装新版后可卸载本脚本；二者有单例守卫，短期并存不冲突。
 */

(() => {
  'use strict';

  // 【已并入 BiliKit-Web Core】检测到 Core 在运行则提示本独立脚本可卸载（一次性、可关闭；不影响本脚本功能）。
  if (window.top === window.self) setTimeout(() => {
    try {
      if (Date.now() - (Number(localStorage.getItem('bilikit:alive.core')) || 0) > 15000) return;
      const K = 'bilikit:dismiss.legacy-wake-lock';
      if (localStorage.getItem(K)) return;
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483600;max-width:300px;padding:10px 34px 10px 14px;border-radius:10px;background:rgba(22,23,28,.96);color:#e3e5e7;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      b.innerHTML = '「防睡眠」已并入 <b style="color:#fb7299">BiliKit-Web Core</b>，本独立脚本可卸载。<a href="https://github.com/shiinayane/BiliKit-Web" target="_blank" rel="noopener" style="color:#fb7299;text-decoration:none">详情</a>';
      const x = document.createElement('span');
      x.textContent = '✕';
      x.style.cssText = 'position:absolute;top:7px;right:11px;cursor:pointer;opacity:.55';
      x.onclick = () => { try { localStorage.setItem(K, '1'); } catch (e) {} b.remove(); };
      b.appendChild(x);
      (document.body || document.documentElement).appendChild(b);
    } catch (e) {}
  }, 2500);

  if (!('wakeLock' in navigator)) {
    console.log('[WakeLock] Not supported');
    return;
  }

  // 单例守卫：防止脚本被重复安装/注入导致重复监听 / 多次 wakeLock 申请。
  if (window.__BILIKIT_WAKE_LOCK__) return;
  window.__BILIKIT_WAKE_LOCK__ = true;

  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[WakeLock]', ...args); };

  let sentinel = null;
  let currentVideo = null;
  let retryTimer = null;
  let acquiring = false; // 申请进行中，防并发申请导致泄漏一个锁

  async function requestWakeLock() {
    if (sentinel || acquiring) return;
    // 没有在播的视频不申请：防止「释放后安排重试 → 期间用户暂停 → 重试仍拿锁」让屏幕常亮。
    if (!currentVideo || currentVideo.paused) return;
    // 页面隐藏时无法申请（且系统会自动释放），直接返回；切回可见时由 visibilitychange 重新申请，
    // 避免「隐藏 → 申请失败 → 重试 → 再失败」的无效循环。
    if (document.visibilityState !== 'visible') return;

    acquiring = true;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      log('acquired');

      sentinel.addEventListener('release', () => {
        log('released');
        sentinel = null;

        // 如果视频还在播，自动重新申请（隐藏导致的释放会被 requestWakeLock 的可见性检查挡掉）
        if (currentVideo && !currentVideo.paused) {
          retryWakeLock();
        }
      });

      // await 在途时用户可能已暂停/切走：拿到了也立刻放掉。
      // release 监听里的 paused 检查会拦住无谓的重试。
      if (!currentVideo || currentVideo.paused || document.visibilityState !== 'visible') {
        log('stale acquire, releasing');
        await sentinel.release();
      }
    } catch (err) {
      log('failed:', err);
      retryWakeLock();
    } finally {
      acquiring = false;
    }
  }

  function retryWakeLock() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestWakeLock();
    }, 2000);
  }

  async function releaseWakeLock() {
    // 同时取消待执行的重试，避免暂停后定时器把锁「复活」
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      if (sentinel) {
        await sentinel.release();
        sentinel = null;
        log('manually released');
      }
    } catch (_) {}
  }

  // 停播信号直接挂在被接管的元素上，而非 document 捕获代理：
  // B 站重建播放器时会把正在播的 <video> 移出 DOM，脱离后元素上触发的
  // pause/ended 没有祖先链，document 捕获听不到——直挂监听不受影响。
  // emptied 兜底元素被复用重置（load()/换 src）的情况。
  const onMediaStop = (e) => {
    if (e.target === currentVideo) releaseWakeLock();
  };
  function bindVideo(v) {
    if (currentVideo === v) return;
    if (currentVideo) {
      currentVideo.removeEventListener('pause', onMediaStop);
      currentVideo.removeEventListener('ended', onMediaStop);
      currentVideo.removeEventListener('emptied', onMediaStop);
    }
    log('bind new video');
    currentVideo = v;
    v.addEventListener('pause', onMediaStop);
    v.addEventListener('ended', onMediaStop);
    v.addEventListener('emptied', onMediaStop);
  }

  // 开播信号仍走 document 捕获代理（媒体事件不冒泡但会经过捕获阶段）：
  // 换 P、播放器重建后的新元素一开播就会被接管，无需 MutationObserver
  // 盯着弹幕页的高频 DOM 变动。
  document.addEventListener('playing', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    bindVideo(e.target);
    requestWakeLock();
  }, true);

  // 监听页面可见性：切回可见且仍在播放时重新申请
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      currentVideo &&
      !currentVideo.paused
    ) {
      log('visibility resume');
      requestWakeLock();
    }
  });

  // 启动时已在播放的视频不会再触发 playing，主动找一次
  const initial = document.querySelector('video');
  if (initial && !initial.paused) {
    bindVideo(initial);
    requestWakeLock();
  }

})();
