// ==UserScript==
// @name         BiliKit-Web · 回程（已废弃，请改用 BiliKit-Web Core）
// @name:en      BiliKit-Web · Way Back (DEPRECATED — use BiliKit-Web Core)
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.9.5
// @description    ⚠️【已停止单独维护，建议改用 BiliKit-Web 套件 Core + Feed】视频标签页的来时路：站内跨视频跳转零刷新压扁（历史钉在 1，链接新开的标签左滑即原生关闭），左下角悬浮回退栈点击即跳回并续播。与 BiliKit-Web·浮窗抽屉自动协同。
// @description:en Flatten in-site cross-video SPA history with zero reloads (history pinned at 1, so Safari's native swipe closes link-opened tabs), and keep a floating back-stack you can click to jump back, resuming playback. Auto-coordinates with BiliKit-Web Float.
// @author       shiinayane
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/cheese/play/*
// @match        *://www.bilibili.com/festival/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/582008/BiliKit%20%C2%B7%20%E5%9B%9E%E7%A8%8B.user.js
// @updateURL https://update.greasyfork.org/scripts/582008/BiliKit%20%C2%B7%20%E5%9B%9E%E7%A8%8B.meta.js
// ==/UserScript==

/*
 * 解决的场景：标签页里连续跳了很多视频后，「回到之前的某个视频」和「看完离开」
 * 都不该靠一格格按返回。
 *
 * 两件套：
 * 1. 历史压扁（仅 SPA）—— 站内跨视频跳转由 B 站自己的 pushState 完成，包一层
 *    改写成 replaceState：零重载、历史深度钉在 1。由此白赚 Safari 的原生行为：
 *    链接自动新开的标签页（B 站视频链接都是 target=_blank）只要历史保持 1，
 *    两指左滑 = 关闭标签页并回到来源页——「关闭」不归本脚本管，零适配、
 *    零误触面，与 BiliKit-Web·Float 天然共存（⌘点击等手动开的标签 Safari 本就
 *    不给此待遇，视为各自独立，不在处理范围内）。
 *    不拦截链接点击——拦截会把 B 站的 SPA 跳转打断成整页重载（也曾与 Float
 *    的点击接管叠加造成双重加载）。真·整页导航（少数链接、JS 赋值 location）
 *    会压一条历史：左滑变成先回退一格，回退栈照样记录了来时路。
 *    float 抽屉打开期间（html.bfloat-open）跳过改写但照记栈；分 P 切换保留 push。
 * 2. 回退栈 —— 被压扁的「来时路」记在 sessionStorage（按标签页隔离，关页即清）。
 *    左下角常驻胶囊「↩ N」（0 层灰显）：悬停展开列表，底部序号 0 是正在播放
 *    的「你在这里」行（不可点，带播放指示），向上 1、2、3…是来时路，序号即
 *    「往回退几层」。点任意一项跳回（location.replace + ?t= 续播，跳回第 i 层
 *    丢弃其上的层）；点胶囊回退一层。
 */
(() => {
  'use strict'

  // 仅顶层窗口运行：不进 BiliKit-Web·Float 的抽屉 iframe
  if (window.top !== window.self) return

  // 单例守卫：防止重复安装/注入导致 pushState 被包多层、甩动判定翻倍
  if (window.__BILIKIT_WAY_BACK__) return
  window.__BILIKIT_WAY_BACK__ = true

  /* ------------------------------------------------------------------ *
   * 配置（可按需修改）
   * ------------------------------------------------------------------ */
  const CONFIG = {
    showStack: true, // 左下角悬浮回退栈
    resumeTime: true, // 跳回时带上离开时的播放进度(?t=)续播
  }

  const STACK_KEY = 'bilikit-wayback-stack' // float.user.js 推新标签时按此键名摘栈防克隆，改名两边同步
  const STACK_MAX = 20 // 栈深上限，超出丢最老的

  // 提取「同一个视频」的标识：BV/av 号、番剧/课程 ep/ss 号，或列表播放页查询串里的 bvid；取不到返回空串。
  // 注：比 float.user.js 的 VIDEO_LINK_RE 多认 /list/?bvid= 与 /cheese/play/——那边判「链接要不要拦」，
  // 这里判「当前页是哪个视频」，范围更宽无妨；B 站改 URL 形态时两边按各自需要同步。
  function videoIdOf(href) {
    try {
      const u = new URL(href, location.href)
      const p = u.pathname
      return p.match(/\/video\/(BV\w+|av\d+)/i)?.[1]?.toLowerCase()
        // 番剧与付费课程(cheese)都用 ep/ss 号
        || p.match(/\/(?:bangumi|cheese)\/play\/((ep|ss)\d+)/i)?.[1]?.toLowerCase()
        // 稍后再看/收藏夹列表播放页(/list/*)：BV 号在查询串而非路径
        || (u.searchParams.get('bvid') || '').toLowerCase()
        || ''
    } catch (_) {
      return ''
    }
  }

  /* ------------------------------------------------------------------ *
   * 一、回退栈（纯旁观记录，不干预任何导航）
   * ------------------------------------------------------------------ */
  function readStack() {
    try {
      const arr = JSON.parse(sessionStorage.getItem(STACK_KEY) || '[]')
      return Array.isArray(arr) ? arr : []
    } catch (_) {
      return []
    }
  }

  function writeStack(stack) {
    try {
      sessionStorage.setItem(STACK_KEY, JSON.stringify(stack.slice(-STACK_MAX)))
    } catch (_) {
      // 存储被禁/超限则放弃记录，甩动关闭不受影响
    }
  }

  function cleanTitle(raw) {
    // 剥掉串尾连续的站点后缀段。B 站后缀有两种格式：初始 HTML 是
    // 「_哔哩哔哩_bilibili」，SPA 跳转后 JS 设置的是「_哔哩哔哩bilibili」
    // （bilibili 前没有下划线）——所以第二段起分隔符可选；首段必须带分隔符，
    // 正文恰好以这些词结尾的标题不受伤
    return raw.replace(/[_-](哔哩哔哩|bilibili|番剧|动画|电影|电视剧|纪录片|综艺|国创|在线观看|全集)([_-]?(哔哩哔哩|bilibili|番剧|动画|电影|电视剧|纪录片|综艺|国创|在线观看|全集))*$/i, '').trim()
  }

  // 标题随 SPA 跳转异步更新：快速连跳时 document.title 可能还是上一个视频的，
  // 直接取会把旧标题记到新条目上（列表里出现两行同名）。
  // 盯住 <title> 节点（仅此一个节点，开销可忽略），维护「视频 id → 已确认标题」，
  // 记录与展示都按 id 取，杜绝张冠李戴。
  const titleById = new Map()
  function noteTitle() {
    const id = videoIdOf(location.href)
    const t = cleanTitle(document.title)
    if (id && t) titleById.set(id, t)
  }
  function titleFor(href) {
    return titleById.get(videoIdOf(href)) || cleanTitle(document.title) || videoIdOf(href)
  }
  // 同时盯 <head> 的 childList：如果 <title> 节点被整个替换（而非改文本），
  // 只盯旧节点的观察器会无声死掉，标题映射从此停更——看到替换就重挂。
  let titleEl = null
  let headObserved = false
  const titleMo = new MutationObserver(() => {
    if (titleEl && !titleEl.isConnected) {
      titleEl = null
      headObserved = false
      titleMo.disconnect()
      watchTitle()
    }
    noteTitle()
  })
  function watchTitle() {
    if (document.head && !headObserved) {
      headObserved = true
      titleMo.observe(document.head, { childList: true })
    }
    const el = document.querySelector('title') // document-start 时 <head> 可能还没解析到它
    if (el && el !== titleEl) {
      titleEl = el
      titleMo.observe(el, { childList: true, characterData: true, subtree: true })
      noteTitle()
    }
  }
  watchTitle()
  document.addEventListener('DOMContentLoaded', () => watchTitle())

  // 把「即将离开的视频」记入栈顶。prevHref/prevTitle/t 都在离开前捕获。
  // rerender=false 给 pagehide 用：页面正在销毁，重建列表 DOM 是纯浪费。
  function recordEntry(prevHref, prevTitle, t, rerender = true) {
    const id = videoIdOf(prevHref)
    if (!id) return
    const stack = readStack()
    if (stack.length && videoIdOf(stack[stack.length - 1].url) === id) return // 连续同视频去重
    stack.push({
      url: prevHref,
      title: titleById.get(id) || cleanTitle(prevTitle) || id, // 优先取按 id 确认过的标题
      t: CONFIG.resumeTime && t > 0 ? Math.floor(t) : 0,
    })
    // 先裁剪再写/渲染：渲染未裁剪的数组会让下标和存储错位一格，
    // 超过 STACK_MAX 后每次点击都跳错视频
    const trimmed = stack.length > STACK_MAX ? stack.slice(-STACK_MAX) : stack
    writeStack(trimmed)
    if (rerender) renderChip(trimmed)
  }

  // 页面上可能同时有多个 <video>（直播小窗、悬停预览卡片）——进度与播放态
  // 只认主播放器，否则会被毫不相干的视频污染（直播小窗播 5 分钟 →
  // 给只看了 30 秒的视频记下 t=300 的「续播点」）。
  let playerVideo = null // 最近一次在主播放器容器内发出 timeupdate 的元素
  function getVideo() {
    return playerVideo && playerVideo.isConnected ? playerVideo : document.querySelector('video')
  }
  function currentVideoTime() {
    const v = getVideo()
    return v && Number.isFinite(v.currentTime) ? v.currentTime : 0
  }

  // B 站 SPA 跳视频是「先重置播放器、再 pushState」——轮到我们记录时
  // currentTime 已经归零。用捕获阶段的 timeupdate（不冒泡但走捕获，播放中
  // 约 4 次/秒）持续记住最后已知进度，记录时当场取不到就用它兜底。
  let lastPlayedT = 0
  document.addEventListener(
    'timeupdate',
    (e) => {
      const v = e.target
      if (!(v && v.tagName === 'VIDEO' && Number.isFinite(v.currentTime))) return
      const inPlayer = !!v.closest('#bilibili-player, .bpx-player-container')
      if (inPlayer) playerVideo = v
      // 只让主播放器写影子进度。从未识别到主播放器（B 站改容器选择器）时
      // 退化为旧行为（任意 video）——退化的代价是「可能被污染」而非「彻底失效」
      if ((inPlayer || !playerVideo) && v.currentTime > 0) lastPlayedT = v.currentTime
    },
    true,
  )

  function departureTime() {
    const t = currentVideoTime()
    return t > 0 ? t : lastPlayedT
  }

  // SPA 跳转压扁：包一层 pushState，「视频页 → 另一个视频页」改写为 replaceState
  // （state 原样透传）。两个例外：
  // - float 抽屉打开期间不改写——栈顶是抽屉的关闭锚点，replace 会把它炸掉
  //   （背景页自动连播 + 抽屉打开的组合）。判断依据是 <html> 的 bfloat-open 类
  //   （抽屉的活状态），而非 history.state.bfloatDrawer：那个标记在「连播把条目
  //   压在锚点上 → 关抽屉 back() 落回锚点」之后会残留在当前条目上，按它判断
  //   会从此永久关停压扁。改写跳过时回退栈照记，来时路不丢。
  // - 番剧 ss→ep 是同一内容的 URL 规范化改写：照样压扁，但不记入回退栈。
  const origPush = history.pushState
  history.pushState = function (...args) {
    // 结构：决策与快照在 try 里，导航动作在外面。Safari 对 history 写入有
    // 限速（约 100 次/30 秒，超出抛 SecurityError）——若把动作也包进兜底
    // catch，改写失败会再触发一次 origPush，把本应抛给调用方的异常变成
    // 二次导航/静默吞掉。动作的异常必须与无脚本时一致地传出去。
    let flatten = false
    let record = false
    let prevHref = ''
    let prevTitle = ''
    let t = 0
    try {
      const url = args[2]
      if (url != null) {
        const target = new URL(url, location.href)
        const prevId = videoIdOf(location.href)
        const curId = videoIdOf(target.href)
        if (prevId && curId && prevId !== curId) {
          record = !(prevId.startsWith('ss') && curId.startsWith('ep'))
          prevHref = location.href // 离开前快照：导航提交后 location 就变了
          prevTitle = document.title
          t = departureTime()
          flatten = !document.documentElement.classList.contains('bfloat-open')
        }
      }
    } catch (_) {
      // URL 解析失败等异常 → 当作与视频无关的 push 原样放行
    }
    if (flatten) {
      try {
        const ret = history.replaceState.apply(this, args)
        // 导航已提交才记录（用预捕获的快照）：记录在前的话，渲染「正在播放」
        // 行时 location 还是旧 URL，列表会出现两行同一个视频
        if (record) {
          recordEntry(prevHref, prevTitle, t)
          lastPlayedT = 0 // 上一个视频的进度已被消费，不能泄漏给下一条记录
        }
        return ret
      } catch (_) {
        // 改写被限速拒绝：不记栈、不清进度，退回原生 push
        //（它若同样被限速而抛出，行为与无脚本时一致）
      }
    } else if (record) {
      // float 抽屉开着：不改写但照记，导航由下面的原生 push 完成
      recordEntry(prevHref, prevTitle, t)
      lastPlayedT = 0
    }
    return origPush.apply(this, args)
  }

  // 兜底：pushState 包不住的整页离开（真·整页链接、JS 赋值 location.href 等）。
  // 不拦截点击——拦了会把 B 站自己的 SPA 跳转打断成整页重载，得不偿失。
  // 这类导航会压一条历史（无法阻止），但来时路被记下，回退栈照样可用；
  // 目的地未知也没关系——若下一页是同一视频（刷新/返回），加载时的去重会弹掉它。
  // jumpTo 自己的 replace 除外：用户是在「回去」，把刚离开的页面记成来时路
  // 会让栈里冒出一条「前进」幽灵。
  let leavingViaJump = false
  window.addEventListener('pagehide', () => {
    if (leavingViaJump) return
    recordEntry(location.href, document.title, departureTime(), false)
  })

  // 跳回第 i 层（i=-1 表示栈顶）：丢弃其上的层（与真实历史的「前进分支销毁」
  // 语义一致），replace 不增历史
  function jumpTo(i) {
    const stack = readStack()
    if (i < 0) i = stack.length - 1
    const entry = stack[i]
    if (!entry) return
    writeStack(stack.slice(0, i))
    leavingViaJump = true
    let href = entry.url
    try {
      const u = new URL(entry.url, location.href)
      if (entry.t > 5) u.searchParams.set('t', String(entry.t)) // 开头几秒不值得续播
      href = u.href
    } catch (_) {}
    location.replace(href)
  }

  // 行点击按 url 现场解析下标：渲染到点击之间栈可能已经变了（悬停期间
  // 自动连播入栈），固化在闭包里的下标会跳错层
  function jumpToUrl(url) {
    const stack = readStack()
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].url === url) return jumpTo(i)
    }
  }

  // 加载时去重：栈顶若与当前视频相同（刷新、原生返回、分 P 的 pagehide 记录）→ 弹掉。
  // backRestore（bfcache 恢复 = 用户原生回退到本页）时更进一步：最近一条「本视频」
  // 记录是离开时的自条目，它之上全是前进侧的幽灵（被回退掉的页面的 pagehide
  // 记录）——一并丢弃，否则「返回」会指向前方。
  function dedupeOnArrival(backRestore = false) {
    const curId = videoIdOf(location.href)
    if (!curId) return
    let stack = readStack()
    const before = stack.length
    if (backRestore) {
      let i = stack.length - 1
      while (i >= 0 && videoIdOf(stack[i].url) !== curId) i--
      if (i >= 0) stack = stack.slice(0, i + 1)
    }
    let n = stack.length
    while (n && videoIdOf(stack[n - 1].url) === curId) n--
    if (n !== before) writeStack(stack.slice(0, n))
  }

  /* ------------------------------------------------------------------ *
   * 二、悬浮回退栈 UI（常驻胶囊：0 层灰显；列表底部序号 0 = 正在播放）
   * ------------------------------------------------------------------ */
  let chipRoot = null
  let listEl = null
  let countEl = null
  let nowRow = null // 「正在播放」行（序号 0）
  let nowTitleEl = null

  function ensureChip() {
    if (chipRoot || !document.body) return
    const style = document.createElement('style')
    style.textContent = `
      .bwb-root {
        /* 故意比 float 遮罩(2147483600)低：抽屉打开时胶囊被罩住，点不到也甩不走宿主页 */
        position: fixed; left: 16px; bottom: 24px; z-index: 2147483500;
        font: 13px/1.5 -apple-system, "PingFang SC", sans-serif;
      }
      /* 自带盒模型，不赌宿主页有没有全局 border-box——
         否则行的 width:100%+padding 会把每行撑得比列表宽，最右侧内容被裁掉 */
      .bwb-root, .bwb-root * { box-sizing: border-box; }
      .bwb-chip {
        display: flex; align-items: center; gap: 6px;
        height: 34px; padding: 0 14px; border-radius: 17px; cursor: pointer;
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(18,18,22,.92); color: #fff;
        font: inherit; font-weight: 500;
        box-shadow: 0 2px 12px rgba(0,0,0,.28);
        opacity: .55; transition: opacity .15s ease, transform .15s ease;
      }
      .bwb-chip svg { display: block; flex: 0 0 auto; }
      .bwb-chip .bwb-count { color: #fb7299; font-variant-numeric: tabular-nums; }
      .bwb-root:hover .bwb-chip { opacity: 1; transform: translateY(-1px); }
      .bwb-chip:active { transform: scale(.96); }
      .bwb-list {
        position: absolute; left: 0; bottom: calc(100% + 10px);
        display: flex; flex-direction: column;
        min-width: 220px; max-width: 320px; max-height: 50vh;
        background-color: rgba(18,18,22,.94); border-radius: 14px; padding: 6px;
        box-shadow: 0 8px 32px rgba(0,0,0,.42);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        opacity: 0; visibility: hidden; transform: translateY(6px);
        pointer-events: none;
        /* 离开后延迟 .15s 再开始收起，给指针迁移留宽限 */
        transition: opacity .16s ease .15s, transform .16s ease .15s, visibility 0s linear .31s;
      }
      /* 列表与胶囊间 10px 间隙的悬停桥：从卡片盒外伸出、什么都不画，指针穿过
         间隙时仍算在列表上，hover 不断链。
         （间隙不能用透明 border 做：backdrop-filter 作用于整个边框盒，会在
         卡片底部留一条「无背景但背后被模糊」的诡异半透明带，圆角也会被吃掉） */
      .bwb-list::after {
        content: ''; position: absolute; top: 100%; left: 0; right: 0; height: 10px;
      }
      /* 滚动收在内层：卡片自身不裁剪，::after 才能伸出盒外 */
      .bwb-scroll { overflow: hidden auto; min-height: 0; }
      .bwb-root:hover .bwb-list {
        opacity: 1; visibility: visible; transform: none; pointer-events: auto;
        transition-delay: 0s;
      }
      .bwb-head {
        padding: 4px 10px 6px; font-size: 11px; color: rgba(255,255,255,.45);
        -webkit-user-select: none; user-select: none; /* 无前缀版 Safari 18.4 才支持 */
      }
      .bwb-item {
        /* 不设 width:100%——竖向 flex 容器默认把子项拉伸到等宽，没有溢出风险 */
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border: none; border-radius: 9px;
        cursor: pointer; background: none; color: #ddd; font: inherit;
        text-align: left;
      }
      .bwb-item:hover { background: rgba(255,255,255,.1); color: #fff; }
      .bwb-item-num {
        flex: 0 0 auto; min-width: 18px; text-align: right;
        font-size: 11px; color: rgba(255,255,255,.35);
        font-variant-numeric: tabular-nums;
        -webkit-user-select: none; user-select: none;
      }
      .bwb-item:hover .bwb-item-num { color: #fb7299; }
      .bwb-item-title {
        flex: 1 1 auto; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .bwb-item-time {
        /* 与 .bwb-now-bars 共用 34px 右列：右缘齐平，标题省略边一致 */
        flex: 0 0 auto; min-width: 34px; text-align: right;
        font-size: 11px; color: rgba(255,255,255,.4);
        font-variant-numeric: tabular-nums;
      }
      .bwb-item:hover .bwb-item-time { color: rgba(255,255,255,.65); }

      /* 0 层：胶囊灰显，点击无事发生（列表仍可悬停，看「正在播放」行） */
      .bwb-empty .bwb-chip { cursor: default; }
      .bwb-empty .bwb-chip .bwb-count { color: rgba(255,255,255,.4); }

      /* 序号 0 =「你在这里」：不可点、无悬停反馈，标题提亮一档与可点项区分 */
      .bwb-now { cursor: default; color: #fff; }
      .bwb-now:hover { background: none; color: #fff; }
      .bwb-now .bwb-item-num, .bwb-now:hover .bwb-item-num { color: #fb7299; }
      /* 播放指示：三根小柱，播放中起伏，暂停时静止在低位；占续播时间的列位 */
      .bwb-now-bars {
        flex: 0 0 auto; min-width: 34px; height: 11px;
        display: flex; gap: 2px; align-items: flex-end; justify-content: flex-end;
      }
      .bwb-now-bars i { width: 2px; height: 4px; border-radius: 1px; background: #fb7299; }
      .bwb-now.bwb-playing .bwb-now-bars i { animation: bwb-eq .9s ease-in-out infinite; }
      .bwb-now.bwb-playing .bwb-now-bars i:nth-child(2) { animation-delay: -.3s; }
      .bwb-now.bwb-playing .bwb-now-bars i:nth-child(3) { animation-delay: -.6s; }
      @keyframes bwb-eq { 0%, 100% { height: 4px; } 50% { height: 11px; } }

      /* 浅色系统主题（theme-sync 让 B 站跟随系统，这里一并跟随） */
      @media (prefers-color-scheme: light) {
        .bwb-chip {
          background: rgba(255,255,255,.92); color: #18191c;
          border-color: rgba(0,0,0,.08);
          box-shadow: 0 2px 12px rgba(0,0,0,.12);
        }
        /* 浅底上 B 站粉(#fb7299)对比不足，换更深的粉保证可读 */
        .bwb-chip .bwb-count { color: #d6336c; }
        .bwb-list {
          background-color: rgba(255,255,255,.95);
          box-shadow: 0 8px 32px rgba(0,0,0,.18);
        }
        .bwb-head { color: rgba(0,0,0,.4); }
        .bwb-item { color: #333; }
        .bwb-item:hover { background: rgba(0,0,0,.06); color: #000; }
        .bwb-item-num { color: rgba(0,0,0,.3); }
        .bwb-item:hover .bwb-item-num { color: #d6336c; }
        .bwb-item-time { color: rgba(0,0,0,.35); }
        .bwb-item:hover .bwb-item-time { color: rgba(0,0,0,.55); }
        .bwb-empty .bwb-chip .bwb-count { color: rgba(0,0,0,.35); }
        .bwb-now { color: #000; }
        .bwb-now:hover { background: none; color: #000; }
        .bwb-now .bwb-item-num, .bwb-now:hover .bwb-item-num { color: #d6336c; }
        .bwb-now-bars i { background: #d6336c; }
      }
    `
    chipRoot = document.createElement('div')
    chipRoot.className = 'bwb-root'
    chipRoot.append(style)

    const card = document.createElement('div')
    card.className = 'bwb-list'
    listEl = document.createElement('div') // 行都挂在内层滚动容器上
    listEl.className = 'bwb-scroll'
    card.appendChild(listEl)

    const chip = document.createElement('div') // 同上，避开 WebKit 的 button-flex bug
    chip.className = 'bwb-chip'
    chip.title = '点击回退一层；悬停查看来时路'
    // 文本字符「↩」的字形基线随字体漂，与数字对不齐 → 用内联 SVG，flex 居中像素级对齐
    chip.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 14 4 9l5-5"/>
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>
      </svg>
      <span class="bwb-count"></span>`
    countEl = chip.querySelector('.bwb-count')
    chip.addEventListener('click', () => jumpTo(-1)) // 回退一层 = 跳回栈顶；0 层时无事发生
    // 悬停展开的瞬间校准「正在播放」行（标题/进度/播放态都以此刻为准）
    chipRoot.addEventListener('mouseenter', updateNowRow)
    // 悬停期间被冻结的行重建，在指针离开后补上
    chipRoot.addEventListener('mouseleave', () => {
      if (rebuildHeldByHover) rebuildList()
    })

    chipRoot.append(card, chip)
    document.body.appendChild(chipRoot)
  }

  function fmtTime(t) {
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const s = String(t % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
  }

  // 悬停/重建时校准「正在播放」行：SPA 跳转后 document.title 异步更新，建列表
  // 那一刻拿到的可能还是旧标题；播放态也以悬停瞬间为准
  function updateNowRow() {
    if (!nowRow) return
    const title = titleFor(location.href)
    nowTitleEl.textContent = title
    nowRow.title = title
    const v = getVideo()
    nowRow.classList.toggle('bwb-playing', !!v && !v.paused)
  }

  let rebuildQueued = false
  let rebuildHeldByHover = false

  function renderChip(knownStack) {
    if (!CONFIG.showStack || !document.body) return
    ensureChip()
    if (!chipRoot) return
    const stack = knownStack || readStack()
    // 计数即时更新（廉价）；行重建合并进微任务——renderChip 可能在 B 站路由
    // 换片的同步调用栈里被 pushState wrapper 触发，不在热路径上做 DOM 重建/布局
    chipRoot.classList.toggle('bwb-empty', !stack.length)
    countEl.textContent = String(stack.length)
    if (!rebuildQueued) {
      rebuildQueued = true
      queueMicrotask(rebuildList)
    }
  }

  function rebuildList() {
    rebuildQueued = false
    // 列表正被注视时冻结行重建：行在眼皮底下换位会让瞄准中的点击落到别的
    // 视频上。计数照常跳，指针离开后补一次重建。
    if (chipRoot.matches(':hover')) {
      rebuildHeldByHover = true
      return
    }
    rebuildHeldByHover = false
    const stack = readStack() // 重建时取最新真相，不用排队时的旧快照
    listEl.textContent = ''
    const head = document.createElement('div')
    head.className = 'bwb-head'
    head.textContent = `来时路 · ${stack.length} 层`
    listEl.appendChild(head)
    stack.forEach((entry, i) => {
      // 不用 <button>：WebKit 的按钮不能当 flex 容器（内容被包进匿名盒，
      // 子项 flex 全失效——时间戳跟在标题后而非右对齐、长标题把时间挤出行外）
      const item = document.createElement('div')
      item.className = 'bwb-item'
      // 序号 = 回退层数：贴近底部的最新一条是 1，越往上越多
      const num = document.createElement('span')
      num.className = 'bwb-item-num'
      num.textContent = String(stack.length - i)
      item.appendChild(num)
      const title = document.createElement('span')
      title.className = 'bwb-item-title'
      title.textContent = entry.title
      item.title = entry.title
      item.appendChild(title)
      if (entry.t > 5) {
        const time = document.createElement('span')
        time.className = 'bwb-item-time'
        time.textContent = fmtTime(entry.t)
        item.appendChild(time)
      }
      item.addEventListener('click', () => jumpToUrl(entry.url))
      listEl.appendChild(item)
    })
    // 序号 0 =「你在这里」：把当前播放钉在最底部（紧贴胶囊），序号语义自洽。
    // 播放指示占续播时间的槽位（最右），与上方各行的时间列对齐。
    nowRow = document.createElement('div')
    nowRow.className = 'bwb-item bwb-now'
    const num = document.createElement('span')
    num.className = 'bwb-item-num'
    num.textContent = '0'
    nowTitleEl = document.createElement('span')
    nowTitleEl.className = 'bwb-item-title'
    const bars = document.createElement('span')
    bars.className = 'bwb-now-bars'
    bars.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))
    nowRow.append(num, nowTitleEl, bars)
    listEl.appendChild(nowRow)
    updateNowRow()
    listEl.scrollTop = listEl.scrollHeight // 溢出时停在最新一条（底部）
  }

  function onReady(backRestore = false) {
    dedupeOnArrival(backRestore)
    renderChip()
  }
  if (document.readyState === 'loading') {
    // 不直接把 onReady 当监听器：事件对象会被当成 backRestore 传进去
    document.addEventListener('DOMContentLoaded', () => onReady())
  } else {
    onReady()
  }
  // bfcache 恢复（原生返回手势回到本页）不触发 DOMContentLoaded，但 pagehide
  // 已经把本页记进了栈——按「回退恢复」语义重跑去重，否则胶囊把「自己」和
  // 被退掉的前方页面当成来时路展示
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    leavingViaJump = false
    onReady(true)
  })
})()
