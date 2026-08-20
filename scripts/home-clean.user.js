// ==UserScript==
// @name         BiliKit-Web · 首页净化
// @name:en      BiliKit-Web · Home Clean
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.1.0
// @description    净化 B 站首页视频流：去广告位 + 顶部 banner，按关键词/UP/播放量过滤，并回收屏外封面图的解码内存。轻量、Safari 友好，不重建首页、不碰 Vue 生命周期。
// @description:en Clean up Bilibili's homepage feed: hide ad slots & top banner, filter by keyword/uploader/play-count, and recycle off-screen cover-image memory. Lightweight, Safari-friendly, no feed rebuild.
// @author       shiinayane
// @match        *://www.bilibili.com/
// @match        *://www.bilibili.com/?*
// @match        *://www.bilibili.com/index.html*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 实测：原生首页本身就「无限累积、不虚拟化」——滚十几屏，卡片 22→322、DOM 1294→12060、
 * 解码图片 34→214MB，屏外卡片一张不回收。框架是 Vue(scoped)+Pinia。
 *
 * 本脚本不重建首页(那是 Bilibili-Gate 那种重型 React 应用的路子，反而吃 2GB)，只做四件轻活：
 *   1. 去广告位 .floor-single-card；2. 去顶部 banner .recommended-swipe；
 *   3. 按关键词/UP/播放量过滤普通卡 .bili-feed-card；
 *   4. 压内存：屏外封面图卸掉 src 释放解码位图、滑回再恢复(只回收已加载的封面，不碰头像、不删卡、不碰 Vue)。
 *
 * 内存能砍的是那 ~214MB 且持续涨的图片位图；Vue 实例/Pinia 数据那 ~1.4GB 动不了(要动只能上
 * 虚拟化、删 Vue 拥有的卡，风险高，Gate 已证明易翻车)，故不碰——这里换的是「稳 + 干净 + 封顶图片内存」。
 *
 * 性能自律(免得变成又一个把页面拖卡的脚本)：作用域观察首页流容器、不碰 body；变更每帧(rAF)合并；
 * 只处理没打过标记的新卡(:not([data-bk-done]))，不重扫已处理的。
 */
(() => {
  'use strict'
  if (window.__BILIKIT_HOME_CLEAN__) return
  window.__BILIKIT_HOME_CLEAN__ = true

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */
  const BLOCK_KEYWORDS = []     // 标题命中任一关键词 → 隐藏，如 ['鬼畜','带货']
  const BLOCK_UPLOADERS = []    // UP 名命中任一 → 隐藏，如 ['某某营销号']
  const MIN_PLAY = 0            // 播放量低于此值(次) → 隐藏；0 = 不启用，如 10000
  const HIDE_ADS = true         // 隐藏广告位 .floor-single-card
  const HIDE_BANNER = true      // 隐藏顶部轮播 banner .recommended-swipe
  const MANAGE_IMAGES = true    // 接管封面图加载：提前预载(消灭懒加载白占位) + 卸很远的上方(省点内存)
  const PRELOAD_DOWN = 3        // 视口下方提前几屏就把封面强制加载好(越大越不露白、越占内存)
  const KEEP_UP = 2             // 视口上方超过几屏才卸掉封面释放内存(越大越不闪回、越省得少)
  const HIDE_SKELETON = true    // 隐藏未加载完的骨架占位卡(末行那几个灰白格)，加载出标题后自动显示
  const DEBUG = false

  const log = (...a) => { if (DEBUG) console.log('[首页净化]', ...a) }
  const hide = (el) => (el.closest('.feed-card') || el).style.setProperty('display', 'none', 'important')

  // 骨架占位卡 = 还没填出标题的 .bili-video-card。用 :has 实时隐藏，加载出标题即自动现身(CSS 自动翻转,
  // 不误伤真卡、无需 JS 盯)。visibility 而非 display:占着格不抖动,只是看不到那个灰白块。
  if (HIDE_SKELETON) {
    const st = document.createElement('style')
    st.textContent = '.bili-video-card:not(:has(.bili-video-card__info--tit)){visibility:hidden!important}'
    ;(document.head || document.documentElement).appendChild(st)
  }

  /* ------------------------------------------------------------------ *
   * 封面图接管：一个 IntersectionObserver，带不对称 rootMargin——
   *   · 下方 PRELOAD_DOWN 屏：卡片没进视口就把封面强制加载(loading=eager 逼开 B 站偏窄的懒加载阈值)，
   *     滚到眼前已解码 → 消灭「白色占位」；
   *   · 上方 KEEP_UP 屏之外：卸 src 释放位图(仅卸已解码的、兼容 <picture>)，省点内存。
   * 注：首页内存大头其实是 macOS 26 系统级泄漏(整页重载都不释放)，图片只是小头，故偏向「顺滑不露白」。
   * ------------------------------------------------------------------ */
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
  function unloadImg(img) {
    if (img.dataset.bkSrc != null || !img.naturalWidth) return // 已卸 / 还没加载出位图 → 不动
    img.dataset.bkSrc = img.getAttribute('src') || ''
    const pic = img.parentElement
    if (pic && pic.tagName === 'PICTURE') {
      for (const s of pic.querySelectorAll('source[srcset]')) { s.dataset.bkSrcset = s.getAttribute('srcset'); s.removeAttribute('srcset') }
    }
    img.src = BLANK
  }
  function loadImg(img) {
    // ① 若被我们卸过 → 还原
    if (img.dataset.bkSrc != null) {
      const pic = img.parentElement
      if (pic && pic.tagName === 'PICTURE') {
        for (const s of pic.querySelectorAll('source')) if (s.dataset.bkSrcset != null) { s.setAttribute('srcset', s.dataset.bkSrcset); delete s.dataset.bkSrcset }
      }
      if (img.dataset.bkSrc) img.src = img.dataset.bkSrc
      delete img.dataset.bkSrc
    }
    // ② 逼开 B 站懒加载：lazy 改 eager 立刻加载；个别 data-src 占位的也补上
    if (img.loading === 'lazy') img.loading = 'eager'
    if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src
  }
  const io = MANAGE_IMAGES
    ? new IntersectionObserver(
      (entries) => { for (const e of entries) e.isIntersecting ? loadImg(e.target) : unloadImg(e.target) },
      // 上 KEEP_UP 屏、下 PRELOAD_DOWN 屏；进带=预载,出带(上方)=卸图
      { rootMargin: `${Math.round(KEEP_UP * 100)}% 0px ${Math.round(PRELOAD_DOWN * 100)}% 0px` },
    )
    : null

  /* ------------------------------------------------------------------ *
   * 过滤判定
   * ------------------------------------------------------------------ */
  function parsePlay(t) {
    if (!t) return NaN
    const mul = t.includes('亿') ? 1e8 : t.includes('万') ? 1e4 : 1
    const n = parseFloat(t)
    return isNaN(n) ? NaN : n * mul
  }
  function blockReason(card) {
    const title = (card.querySelector('.bili-video-card__info--tit')?.textContent || '').trim()
    const up = (card.querySelector('.bili-video-card__info--author')?.textContent || '').trim()
    if (BLOCK_KEYWORDS.some((k) => k && title.includes(k))) return 'kw'
    if (BLOCK_UPLOADERS.some((u) => u && up.includes(u))) return 'up'
    if (MIN_PLAY > 0) {
      const play = parsePlay(card.querySelector('.bili-video-card__stats--text')?.textContent)
      if (!isNaN(play) && play < MIN_PLAY) return 'play<' + MIN_PLAY
    }
    return ''
  }

  /* ------------------------------------------------------------------ *
   * 处理一轮：扫未处理的 banner / 广告 / 普通卡。:not([data-bk-done]) 保证只碰新卡、不重扫旧的。
   * ------------------------------------------------------------------ */
  let nAd = 0, nFilter = 0, nImg = 0
  function process() {
    if (HIDE_BANNER) for (const b of document.querySelectorAll('.recommended-swipe:not([data-bk-done])')) { b.dataset.bkDone = '1'; b.style.setProperty('display', 'none', 'important') }
    if (HIDE_ADS) for (const a of document.querySelectorAll('.floor-single-card:not([data-bk-done])')) { a.dataset.bkDone = '1'; hide(a); nAd++ }
    for (const card of document.querySelectorAll('.bili-feed-card:not([data-bk-done])')) {
      // 还没填充好的占位卡(没标题) → 跳过且不打标记，等它填好下一轮再处理
      if (!card.querySelector('.bili-video-card__info--tit')) continue
      card.dataset.bkDone = '1'
      const why = blockReason(card)
      if (why) { hide(card); nFilter++; log('过滤', why); continue }
      if (io) {
        const img = card.querySelector('.bili-video-card__cover img') || card.querySelector('picture img') || card.querySelector('img')
        if (img) { io.observe(img); nImg++ }
      }
    }
    if (DEBUG) log(`广告${nAd} 过滤${nFilter} 纳管图片${nImg}`)
  }

  // 变更每帧合并：新一批卡片(滚动加载/换一换)落地 → 排一帧后 process
  let rafId = 0
  const schedule = () => { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; process() }) }

  /* ------------------------------------------------------------------ *
   * 引导：找到首页流容器并作用域观察；没出现就轻量轮询。SPA/换一换在容器内增删，照样捕获。
   * ------------------------------------------------------------------ */
  function findFeed() {
    return [...document.querySelectorAll('.container')].find((c) => c.querySelector('.bili-feed-card, .feed-card, .floor-single-card'))
      || (document.querySelector('.bili-feed-card, .feed-card') || {}).parentElement
      || null
  }
  function start(feed) {
    new MutationObserver(schedule).observe(feed, { childList: true, subtree: true })
    schedule()
    log('已绑定首页流容器', feed.className)
  }
  const feed = findFeed()
  if (feed) start(feed)
  else {
    let tries = 0
    const t = setInterval(() => {
      const f = findFeed()
      if (f) { clearInterval(t); start(f) }
      else if (++tries > 40) clearInterval(t) // ~20s 兜底放弃
    }, 500)
  }

  log('已启动')
})()
