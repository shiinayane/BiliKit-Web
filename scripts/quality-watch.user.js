// ==UserScript==
// @name         BiliKit-Web · 清晰度自适应
// @name:en      BiliKit-Web · Adaptive Quality
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.4.2
// @description    替代 B 站那个一上来就顶 4K 然后卡死的「自动」：从稳妥档起步，网速充裕才逐档上爬，卡顿立刻降档，永不卡死在扛不住的清晰度。
// @description:en Replace Bilibili's "Auto" (which jumps to 4K and stalls): start at a safe level, climb up only when bandwidth is ample, drop instantly on stalls — never stuck buffering at a tier your network can't sustain.
// @author       shiinayane
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/cheese/play/*
// @match        *://www.bilibili.com/festival/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 为什么要它：B 站网页端的「自动」不是 YouTube 那种逐分片无缝 ABR，更像
 * 「起播探一下带宽、在账号允许的上限内挑一档、之后降档非常不积极」。大会员
 * 上限是 4K，起播探测又偏乐观（首个分片从 CDN 边缘秒下、瞬时速率虚高），于是
 * 一上来就顶 4K；真实持续带宽撑不住，缓冲耗尽就一直转圈等下载，而不肯退一步。
 *
 * 本脚本的做法（闭环爬山，只靠 <video> 信号，不重写播放器）：
 * - 接管「自动」：从稳妥档（startQn，默认 1080P）起步，绝不一上来就 4K；
 * - 卡顿降档：缓冲见底 / waiting 频发 → 立刻降一档，并把刚扛不住的那档锁一段
 *   时间不回爬；
 * - 平稳升档：缓冲持续充裕够久 → 试探升一档，没超天花板、没在冷却就上；
 * - 换档不是无缝的（B 站换清晰度会拆掉重建媒体源，约 1 秒重缓冲），所以切档
 *   后有宽限期，不把换流自身的重缓冲误判成卡顿。
 *
 * 与播放器解耦：换档走「点对应档位的菜单项」，按 data-value(qn) 定位而非赌
 * class 名；命令后会确认是否真的切过去，切不动（大会员锁、或选择器不对）就把
 * 那档标记不可用并回退——最坏只是「不起作用」，不会帮倒忙。
 */
(() => {
  'use strict'

  // 单例守卫：重复注入会变成多个看门狗互相打架切档
  if (window.__BILIKIT_QUALITY_WATCH__) return
  window.__BILIKIT_QUALITY_WATCH__ = true

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */
  const CONFIG = {
    floorQn: 32, // 不低于此档（32=480P）：跨境链路坏窗口时能退到撑得住的档；最差还能设 16(360P)
    ceilQn: 120, // 不高于此档（120=4K）；网速撑不住 4K 建议改成 116(1080P60)
    startQn: 80, // 接管「自动」时的起步档（80=1080P）：之后顺网速往上爬
    allowVipTiers: true, // 放开大会员专享档（1080P60/4K 等）。非会员若被弹购买框改 false
    showToast: true, // 切档时左下角轻提示
  }

  // 调参：装好后先设 true 跑一次，控制台会自报探测到的档位/当前档/播放器结构，
  // 确认换档选择器命中后再设回 false
  const DEBUG = true // 调参期开着看心跳；定稿后改 false
  const log = (...a) => { if (DEBUG) console.log('[QualityWatch]', ...a) }

  // 清晰度档位码（qn）→ 名称。B 站菜单项的 data-value 即此码。
  const QN_LABEL = {
    6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
    80: '1080P', 100: '智能修复', 112: '1080P 高码率', 116: '1080P60',
    120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K',
  }

  /* ------------------------------------------------------------------ *
   * 时间/阈值常量（毫秒 / 秒）
   * ------------------------------------------------------------------ */
  const POLL_MS = 2000 // 评估周期
  const SWITCH_GRACE_MS = 6000 // 切档后这段时间内的卡顿不计（换流必然重缓冲）
  const STALL_WINDOW_MS = 25000 // 卡顿计数的滑动窗口
  const STALL_TRIGGER = 2 // 窗口内卡顿达到此次数 → 降档
  const LONG_STALL_MS = 3500 // 单次卡顿持续超过此值 → 立即降档
  const SMOOTH_CLIMB_MS = 60000 // 缓冲稳在安全线之上、无卡顿持续这么久 → 升一档
  const BACKOFF_MS = 90000 // 刚因卡顿降下来的那一档，锁定这么久不回爬（防来回横跳）
  const CONFIRM_MS = 8000 // 命令切档后这么久仍没切到 → 判定该档不可用
  const BUFFER_LOW = 2 // 播放中缓冲领先低于此秒数 = 危险
  const CLIMB_SAFE = 5 // 缓冲领先稳稳高于此秒数（且无卡顿）才累计升档计时
  // 说明：升档不再要求「缓冲堆到很高」（B 站前向缓冲未必堆得上去），改为
  // 「稳稳高于危险线、没卡顿、持续够久」——更贴合播放器真实缓冲深度。

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  let video = null
  let targetQn = 0 // 我们命令的目标档；0 = 尚未接管
  let pendingQn = 0 // 已命令但还没确认生效的档
  let pendingSince = 0
  let lastSwitchAt = 0
  let smoothSince = 0 // 连续平稳的起点
  let waitingSince = 0 // 本次卡顿（waiting）的起点；0=没在卡
  let stalls = [] // 最近卡顿时间戳
  const lockedUntil = {} // qn → 时间戳：刚扛不住的档，回爬冷却到期前不碰
  const failCount = {} // qn → 累计扛不住次数：反复失败的档，冷却递增拉长
  const unavailable = new Set() // 确认切不过去的档（账号锁 / 选择器不对）

  const now = () => Date.now()

  /* ------------------------------------------------------------------ *
   * 播放器探测：只认主播放器里的 <video>，换 P/重建后重绑
   * ------------------------------------------------------------------ */
  function playerScope() {
    return document.querySelector('.bpx-player-container') || document
  }

  function findVideo() {
    const v = document.querySelector('.bpx-player-container video') || document.querySelector('video')
    return v && v.tagName === 'VIDEO' ? v : null
  }

  // 只认 waiting（播放因取不到下一帧而暂停）且缓冲确实见底的卡顿。
  // 不听 stalled：MSE 缓冲喂饱后播放器停止取流，这个「网络空闲」也会触发
  // stalled，与播放卡顿无关，会把卡顿数刷爆。再加缓冲门槛双保险：缓冲还厚
  // 时的 waiting（少见，多为解码抖动/seek）也不算带宽卡顿。
  const onWaiting = () => {
    if (!video || video.seeking) return
    if (now() - lastSwitchAt < SWITCH_GRACE_MS) return // 换流自身的重缓冲不算
    if (bufferedAhead() > BUFFER_LOW * 2) return // 缓冲还厚 → 不是带宽卡顿
    waitingSince = waitingSince || now()
    stalls.push(now())
  }
  const onResume = () => { waitingSince = 0 }

  function bindVideo(v) {
    if (video === v) return
    if (video) {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onResume)
      video.removeEventListener('canplay', onResume)
    }
    video = v
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('playing', onResume)
    v.addEventListener('canplay', onResume)
    // 新流：重置瞬态卡顿状态、给一段宽限；targetQn 跨 P 保留（同一网络环境）
    stalls = []
    waitingSince = 0
    smoothSince = now()
    pendingQn = 0
    lastSwitchAt = now()
    log('bind video', v)
  }

  // 缓冲领先：当前播放点到所在缓冲区段末尾还有多少秒
  function bufferedAhead() {
    if (!video) return 0
    const t = video.currentTime
    const b = video.buffered
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.5 && t <= b.end(i) + 0.5) return Math.max(0, b.end(i) - t)
    }
    return 0
  }

  /* ------------------------------------------------------------------ *
   * 清晰度读写：锚定清晰度菜单项，按 data-value(qn) 取档
   * （同页还有倍速/弹幕等也带 data-value，故必须限定到清晰度菜单内）
   * ------------------------------------------------------------------ */
  const isActive = (el) => [...el.classList].some((c) => c.includes('active'))

  function qnItems() {
    return [...playerScope().querySelectorAll('.bpx-player-ctrl-quality-menu-item[data-value]')]
      .map((el) => ({
        el,
        qn: parseInt(el.getAttribute('data-value'), 10),
        vip: !!el.querySelector('.bpx-player-ctrl-quality-badge-bigvip'), // 大会员专享档
        active: isActive(el),
      }))
      .filter((x) => x.qn in QN_LABEL) // 排除「自动」(0) 与异常值
  }

  // 「自动」当前是否生效（data-value="0" 那项激活）——它就是我们要替代的模式
  function isAutoActive() {
    const auto = playerScope().querySelector('.bpx-player-ctrl-quality-menu-item[data-value="0"]')
    return !!auto && isActive(auto)
  }

  // 当前生效的档：优先读 B 站播放器配置 media.quality（最稳），回退到菜单激活项
  function currentQn() {
    try {
      const p = JSON.parse(localStorage.getItem('bpx_player_profile') || '{}')
      const q = p?.media?.quality ?? p?.quality
      if (Number.isFinite(q) && q in QN_LABEL) return q
    } catch (_) {}
    const act = qnItems().find((x) => x.active)
    return act ? act.qn : 0
  }

  // 当前账号实际可选、落在 [floor,ceil]、未被标记不可用的档，升序。
  // 非大会员时排除会员档，避免看门狗点到 4K 弹出购买弹窗。
  function rangeQns() {
    const seen = new Set()
    return qnItems()
      .filter((x) => x.qn >= CONFIG.floorQn && x.qn <= CONFIG.ceilQn
        && !unavailable.has(x.qn) && (CONFIG.allowVipTiers || !x.vip))
      .map((x) => x.qn)
      .filter((q) => (seen.has(q) ? false : seen.add(q)))
      .sort((a, b) => a - b)
  }

  function clampToRange(q, range) {
    if (!range.length) return 0
    const le = range.filter((x) => x <= q)
    return le.length ? le[le.length - 1] : range[0] // 取不超过 q 的最大档，否则取最低可用
  }
  const nextUp = (q, range) => range.find((x) => x > q)
  const nextDown = (q, range) => [...range].reverse().find((x) => x < q)

  function switchTo(qn, reason) {
    const item = qnItems().find((x) => x.qn === qn)
    if (!item) { log('找不到档位项', qn); return }
    if (currentQn() === qn) { targetQn = qn; return }
    // 菜单项需先唤起其控件容器（悬停展开）才稳妥响应点击，先发 mouseenter 再点
    const ctrl = item.el.closest('.bpx-player-ctrl-quality')
    if (ctrl) ctrl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    item.el.click()
    targetQn = qn
    pendingQn = qn
    pendingSince = now()
    lastSwitchAt = now()
    log('切换 →', QN_LABEL[qn], `（${reason}）`)
    if (CONFIG.showToast) toast(`清晰度 → ${QN_LABEL[qn]}`, reason)
  }

  /* ------------------------------------------------------------------ *
   * 决策大脑：每 POLL_MS 跑一次
   * ------------------------------------------------------------------ */
  function evaluate() {
    const v = findVideo()
    if (v) bindVideo(v)
    if (!video || video.paused || video.seeking) return

    const range = rangeQns()
    if (!range.length) return // 菜单还没就绪 / 结构未识别

    const t = now()
    const cur = currentQn()

    // —— 首次接管 ——
    // 已是合理的手动档（非自动、落在范围内）→ 原样接管，不打扰用户当前选择；
    // 否则（自动 / 超范围）→ 设到稳妥起步档，之后顺网速爬。
    if (!targetQn) {
      if (!isAutoActive() && range.includes(cur)) {
        targetQn = cur
        log('接管当前档', QN_LABEL[cur])
      } else {
        const start = clampToRange(CONFIG.startQn, range)
        switchTo(start, isAutoActive() ? '接管自动' : '校正起步档')
      }
      smoothSince = t
      return
    }

    // —— 确认上一次切档是否真的生效 ——
    if (pendingQn) {
      if (cur === pendingQn) {
        pendingQn = 0
      } else if (t - pendingSince > CONFIRM_MS) {
        unavailable.add(pendingQn) // 切不过去：账号锁或选择器不对 → 弃用此档
        log('该档不可用，弃用', pendingQn)
        pendingQn = 0
        const fb = nextDown(targetQn, rangeQns()) || clampToRange(CONFIG.startQn, rangeQns())
        if (fb && fb !== targetQn) switchTo(fb, '该档不可用，回退')
        else targetQn = fb || targetQn
        return
      } else {
        return // 等待确认期间不做新决策
      }
    }

    const ahead = bufferedAhead()
    if (DEBUG) {
      const lockedNow = Object.keys(lockedUntil).filter((q) => lockedUntil[q] > t).map(Number)
      log('tick', {
        档: QN_LABEL[targetQn], 缓冲: ahead.toFixed(1), 卡顿数: stalls.length,
        平稳秒: smoothSince ? ((t - smoothSince) / 1000).toFixed(0) : '-',
        冷却中: lockedNow.map((q) => QN_LABEL[q]),
        可选: range.map((q) => QN_LABEL[q]),
      })
    }

    // —— 切档宽限期：换流必然重缓冲，不评估卡顿 ——
    if (t - lastSwitchAt < SWITCH_GRACE_MS) { smoothSince = t; return }

    // —— 卡顿 → 降档 ——
    stalls = stalls.filter((ts) => t - ts < STALL_WINDOW_MS)
    const longStalling = waitingSince && t - waitingSince > LONG_STALL_MS
    if (stalls.length >= STALL_TRIGGER || longStalling) {
      const lower = nextDown(targetQn, range)
      if (lower) {
        // 反复扛不住的档冷却递增（90s、180s…最多 5 倍），省得网速撑不住时
        // 每个冷却周期都去同一档撞一次墙
        failCount[targetQn] = (failCount[targetQn] || 0) + 1
        lockedUntil[targetQn] = t + BACKOFF_MS * Math.min(failCount[targetQn], 5)
        stalls = []
        switchTo(lower, '卡顿降档')
      }
      smoothSince = t
      return
    }

    // —— 缓冲稳在安全线之上、无卡顿、持续够久 → 升一档 ——
    if (ahead >= CLIMB_SAFE && !waitingSince) {
      if (!smoothSince) smoothSince = t
      if (t - smoothSince >= SMOOTH_CLIMB_MS) {
        const upper = nextUp(targetQn, range)
        if (upper && (lockedUntil[upper] || 0) < t) switchTo(upper, '网速充裕升档')
        smoothSince = t // 不论升没升都重置计时，避免连环跳档
      }
    } else {
      smoothSince = t // 跌破安全线或正在卡，升档计时重来
    }
  }

  /* ------------------------------------------------------------------ *
   * 轻提示
   * ------------------------------------------------------------------ */
  let toastEl = null
  let toastTimer = null
  function toast(text, sub) {
    if (!document.body) return
    if (!toastEl) {
      const style = document.createElement('style')
      style.textContent = `
        .bqw-toast {
          position: fixed; left: 16px; bottom: 24px; z-index: 2147483500;
          display: flex; flex-direction: column; gap: 2px;
          background: rgba(18,18,22,.92); color: #fff;
          font: 13px/1.4 -apple-system, "PingFang SC", sans-serif;
          padding: 9px 14px; border-radius: 12px;
          box-shadow: 0 4px 18px rgba(0,0,0,.34);
          opacity: 0; transform: translateY(6px);
          transition: opacity .2s ease, transform .2s ease; pointer-events: none;
        }
        .bqw-toast.bqw-show { opacity: 1; transform: none; }
        .bqw-toast b { font-weight: 600; color: #fb7299; font-variant-numeric: tabular-nums; }
        .bqw-toast span { font-size: 11px; color: rgba(255,255,255,.55); }
        @media (prefers-color-scheme: light) {
          .bqw-toast { background: rgba(255,255,255,.95); color: #18191c; box-shadow: 0 4px 18px rgba(0,0,0,.16); }
          .bqw-toast b { color: #d6336c; }
          .bqw-toast span { color: rgba(0,0,0,.5); }
        }
      `
      toastEl = document.createElement('div')
      toastEl.className = 'bqw-toast'
      document.body.append(style, toastEl)
    }
    toastEl.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`
    // 强制 reflow 再加显示类，保证每次都过渡
    void toastEl.offsetHeight
    toastEl.classList.add('bqw-show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('bqw-show'), 2200)
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  setInterval(evaluate, POLL_MS)
  log('started', CONFIG)
})()
