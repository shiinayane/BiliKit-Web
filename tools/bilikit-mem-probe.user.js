// ==UserScript==
// @name         BiliKit-Web Mem Probe（内存侧测探针·调试用）
// @namespace    bilikit.debug
// @version      1.1.0
// @description  Safari 无 JS 堆 API，故侧测「与内存强相关」的代理指标：DOM 节点数、各 <video> 的 buffered 秒数(按来源分类)、outstanding objectURL、检测到的「已脱离 DOM 但未回收」的 video。每 5s 采样，Ctrl+Shift+M 导出 JSON。刷半天后导出发回分析。
// @match        *://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes     false
// ==/UserScript==

/*
 * 用法：
 *  1) 侧载本脚本（与 BiliKit-Web Core/Feed 并存）；
 *  2) 正常刷首页 / 开抽屉看视频「半天」，控制台每 5s 会打一行趋势（[bkProbe top] t=…s dom=… vDom=… …）；
 *  3) 感觉内存飙了、或刷够了 → 在**顶层页面**按 Ctrl+Shift+M（或控制台执行 __bkProbe.dump()）；
 *     → 会把全部采样（含同源子框架/抽屉 iframe 的）合并成 JSON：复制到剪贴板 + 下载成文件 + 打到控制台；
 *  4) 把那个 JSON（或下载的文件）发回。我看哪个指标在飙升前**单调增长**，即定位泄漏来源。
 *
 * 关键指标解读：
 *  - vBufSec / vBufMax：所有 <video> 的 buffered 总秒数 / 单个最大。这是媒体缓冲内存的直接代理，飙到很大 = 缓冲没被回收。
 *  - vFeed / vPlayer / vOther + 子框架样本：按来源分类，直指「是 Feed 悬停预览、还是播放器、还是抽屉」在吃内存。
 *  - vDetached：本世界创建、已脱离 DOM 但仍未被 GC 的 <video>（疑似泄漏；受 userscript 世界隔离限制，可能只覆盖部分）。
 *  - dom：整页 DOM 节点数。若无界单调增长 = 有脱离节点树没被释放（DOM 泄漏）。
 *  - ouOut：本世界 URL.createObjectURL 未被 revoke 的净值。持续增长 = objectURL 泄漏。
 *  - mem：Safari 恒为 'n/a'（无堆 API）；仅 Chrome 有值，供跨浏览器对照。
 */

(function () {
  'use strict'
  if (window.__bkProbe) return

  var t0 = Date.now()
  var isTop = window.top === window.self
  var frameTag = isTop ? 'top' : ('iframe:' + (location.pathname + location.hash).slice(0, 48))

  // —— 追踪本世界创建的 <video>/<audio>：用 WeakRef 记住，采样时数「还活着但已脱离 DOM」的（疑似泄漏）——
  var tracked = new Set()
  function track(el) { try { if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) tracked.add(new WeakRef(el)) } catch (e) {} return el }
  try {
    var _create = Document.prototype.createElement
    Document.prototype.createElement = function (tag) {
      var el = _create.apply(this, arguments)
      try { if (String(tag).toLowerCase() === 'video' || String(tag).toLowerCase() === 'audio') track(el) } catch (e) {}
      return el
    }
  } catch (e) {}

  // —— objectURL 收支：净未回收数 = created - revoked ——
  var ouCreated = 0, ouRevoked = 0
  try {
    var _co = URL.createObjectURL
    URL.createObjectURL = function (o) { ouCreated++; return _co.call(this, o) }
    var _ro = URL.revokeObjectURL
    URL.revokeObjectURL = function (u) { ouRevoked++; return _ro.call(this, u) }
  } catch (e) {}

  // —— MediaSource / ManagedMediaSource：数「已创建且未被 GC」的实例 ——
  var msAlive = new Set()
  function wrapMS(name) {
    try {
      var Orig = window[name]
      if (!Orig) return
      var Wrapped = function () {
        var m = Reflect.construct(Orig, arguments, Wrapped)
        try { msAlive.add(new WeakRef(m)) } catch (e) {}
        return m
      }
      Wrapped.prototype = Orig.prototype
      Object.setPrototypeOf(Wrapped, Orig)
      // 拷贝静态方法（如 isTypeSupported）
      Object.getOwnPropertyNames(Orig).forEach(function (k) {
        if (['length', 'name', 'prototype'].indexOf(k) === -1) {
          try { Wrapped[k] = Orig[k] } catch (e) {}
        }
      })
      window[name] = Wrapped
    } catch (e) {}
  }
  wrapMS('MediaSource')
  wrapMS('ManagedMediaSource')

  // —— 采样 ——
  var samples = []
  function derefAlive(set) { var n = 0; set.forEach(function (r) { if (r.deref()) n++; else set.delete(r) }); return n }
  function perfMem() { try { var m = performance.memory; return m ? Math.round(m.usedJSHeapSize / 1048576) + 'MB' : 'n/a(safari)' } catch (e) { return 'n/a' } }

  // 穿透同源 iframe（抽屉 iframe 带 allow-same-origin，顶层可读其 contentDocument）枚举所有 <video>，
  // 逐个分类：feed=Feed 悬停预览，player=顶层 B 站播放器，drawer=抽屉 iframe 内播放器，other=其它。
  function eachVideo(cb) {
    function walkDoc(doc, zone) {
      try {
        var vs = doc.getElementsByTagName('video')
        for (var i = 0; i < vs.length; i++) {
          var v = vs[i], cls = zone
          try {
            if (zone === 'top') {
              if (v.closest && v.closest('.bk-feed-vpreview, .bk-feed-cover, .bk-feed-card')) cls = 'feed'
              else if (v.closest && v.closest('.bpx-player-container, .bpx-player, #bilibili-player')) cls = 'player'
              else cls = 'other'
            }
          } catch (e) {}
          cb(v, cls)
        }
        var ifr = doc.getElementsByTagName('iframe')
        for (var k = 0; k < ifr.length; k++) {
          try {
            var d = ifr[k].contentDocument
            if (d) walkDoc(d, (ifr[k].src || '').indexOf('bk-drawer') >= 0 ? 'drawer' : 'iframe')
          } catch (e) { /* 跨源 iframe 读不到，忽略 */ }
        }
      } catch (e) {}
    }
    walkDoc(document, 'top')
  }

  function sample(mark) {
    var byClass = { feed: 0, player: 0, drawer: 0, iframe: 0, other: 0 }
    var bufByClass = { feed: 0, player: 0, drawer: 0, iframe: 0, other: 0 }
    var vTotal = 0, bufSec = 0, bufMax = 0, playing = 0
    eachVideo(function (v, cls) {
      vTotal++
      byClass[cls] = (byClass[cls] || 0) + 1
      try { if (!v.paused && !v.ended) playing++ } catch (e) {}
      try {
        var b = v.buffered, sec = 0
        for (var j = 0; j < b.length; j++) sec += (b.end(j) - b.start(j))
        bufSec += sec; bufByClass[cls] = (bufByClass[cls] || 0) + sec
        if (sec > bufMax) bufMax = sec
      } catch (e) {}
    })
    // 本世界追踪的 video：还活着 vs 已脱离 DOM
    var vAlive = 0, vDetached = 0
    tracked.forEach(function (r) { var el = r.deref(); if (!el) { tracked.delete(r); return } vAlive++; try { if (!el.isConnected) vDetached++ } catch (e) {} })

    var s = {
      t: Math.round((Date.now() - t0) / 1000),
      frame: frameTag,
      dom: document.getElementsByTagName('*').length,
      vTotal: vTotal,
      vFeed: byClass.feed, vPlayer: byClass.player, vDrawer: byClass.drawer, vIframe: byClass.iframe, vOther: byClass.other,
      vPlaying: playing,
      vBufSec: Math.round(bufSec), vBufMax: Math.round(bufMax),
      bufDrawer: Math.round(bufByClass.drawer), bufPlayer: Math.round(bufByClass.player), bufFeed: Math.round(bufByClass.feed),
      vAlive: vAlive, vDetached: vDetached,
      imgs: document.getElementsByTagName('img').length,
      iframes: document.getElementsByTagName('iframe').length,
      ouOut: ouCreated - ouRevoked, ouCreated: ouCreated,
      msAlive: derefAlive(msAlive),
      mem: perfMem(),
    }
    if (mark) s.mark = mark
    samples.push(s)
    if (samples.length > 5000) samples.shift() // ~7h @5s 上限，防探针自己吃内存
    try {
      console.log('[bkProbe] t=' + s.t + 's' + (mark ? ' «' + mark + '»' : '') + ' dom=' + s.dom +
        ' v=' + s.vTotal + '(feed' + s.vFeed + '/play' + s.vPlayer + '/drawer' + s.vDrawer + '/oth' + s.vOther + ')' +
        ' buf=' + s.vBufSec + 's[drawer' + s.bufDrawer + '/play' + s.bufPlayer + '/feed' + s.bufFeed + ']' +
        ' iframe=' + s.iframes + ' ou=' + s.ouOut + ' ms=' + s.msAlive + ' mem=' + s.mem)
    } catch (e) {}
    return s
  }

  // 顶层导出：合并自身 + 同源子框架（抽屉 iframe）的样本
  function collectAll() {
    var out = samples.slice()
    function walk(win) {
      for (var i = 0; i < win.frames.length; i++) {
        try {
          var w = win.frames[i]
          var p = w.__bkProbe
          if (p && p !== window.__bkProbe) out = out.concat(p.raw())
          walk(w)
        } catch (e) { /* 跨源框架忽略 */ }
      }
    }
    if (isTop) walk(window)
    out.sort(function (a, b) { return a.t - b.t })
    return out
  }
  function dump() {
    var data = collectAll()
    var json = JSON.stringify(data)
    try { console.log('%c[bkProbe] DUMP ' + data.length + ' samples（已复制到剪贴板 + 下载）', 'font-weight:bold;color:#00aeec', data) } catch (e) {}
    try { navigator.clipboard.writeText(json) } catch (e) {}
    try {
      var a = document.createElement('a')
      a.href = _coSafe(new Blob([json], { type: 'application/json' }))
      a.download = 'bkprobe-' + data.length + '-' + Math.round((Date.now() - t0) / 1000) + 's.json'
      a.click()
    } catch (e) {}
    return data
  }
  // 用原始 createObjectURL（避免把导出自己算进 ouCreated）
  function _coSafe(b) { try { return (_co ? _co.call(URL, b) : URL.createObjectURL(b)) } catch (e) { return URL.createObjectURL(b) } }

  window.__bkProbe = { sample: sample, dump: dump, mark: function (m) { return sample(m || 'mark') }, raw: function () { return samples }, get samples() { return samples } }

  // **只有顶层采样**：顶层已穿透同源 iframe 数到抽屉视频，子框架不再自采，免得（若探针也注入了 iframe）重复计数。
  if (isTop) {
    var timer = setInterval(function () { sample() }, 5000)
    window.addEventListener('pagehide', function () { try { clearInterval(timer) } catch (e) {} })
    sample()
    window.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || !e.shiftKey) return
      if (e.key === 'M' || e.key === 'm') { e.preventDefault(); dump() }
      // Ctrl+Shift+K：打一个事件标记（弹框输入，如「开抽屉」「关抽屉」「切视频」），便于把趋势和你的操作对上
      else if (e.key === 'K' || e.key === 'k') { e.preventDefault(); try { var m = prompt('事件标记（如：开抽屉/关抽屉/切视频）'); if (m) sample('MARK:' + m) } catch (x) { sample('MARK') } }
    })
    try { console.log('%c[bkProbe] 运行中（顶层，穿透同源 iframe 数抽屉视频）。Ctrl+Shift+M 导出 / Ctrl+Shift+K 打标记。Safari 无堆 API，重点看 bufDrawer、关抽屉后降不降。', 'color:#00aeec') } catch (e) {}
  }
})()
