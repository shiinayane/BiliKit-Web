// ==UserScript==
// @name         BiliKit-Web · CDN 优选
// @name:en      BiliKit-Web · CDN Pick
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.7.5
// @description    ⚠️【已废弃·功能并入 BiliKit-Web Core，请改装 Core】把 B 站视频分片重定向到指定 CDN 镜像，绕开被分到的慢节点（海外 Akamai 等）。Safari 友好：页面世界注入、不依赖 GM/unsafeWindow，故能拦到播放器真正的请求（CCB 等脚本在 Safari Userscripts 下因 grant 被注入隔离世界而失效）。
// @description:en Redirect Bilibili video segments to a chosen CDN mirror, bypassing the slow node you were assigned (e.g. overseas Akamai). Safari-friendly: page-world injection without GM/unsafeWindow.
// @author       shiinayane
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/cheese/play/*
// @match        *://www.bilibili.com/festival/*
// @match        *://player.bilibili.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/582054/BiliKit%20%C2%B7%20CDN%20%E4%BC%98%E9%80%89.user.js
// @updateURL https://update.greasyfork.org/scripts/582054/BiliKit%20%C2%B7%20CDN%20%E4%BC%98%E9%80%89.meta.js
// ==/UserScript==

/*
 * ⚠️ 已并入 BiliKit-Web Core，建议迁移：本功能已整合进新脚本 BiliKit-Web Core
 * （CDN 优选 + 主题同步 + 评论属地 + 防睡眠 + 统一设置面板），后续更新只在新脚本进行。
 * 安装：https://greasyfork.org/scripts?q=BiliKit-Web
 * 装新版后可卸载本脚本；二者有单例守卫，短期并存不冲突。
 */

/*
 * 原理：B 站把可用清晰度/编码的「带签名的分片地址」放在 playurl 响应里
 * （首帧在 window.__playinfo__，换片/切档时走 /x/player/wbi/playurl 等接口）。
 * 同一条视频通常同时给出多个 CDN 的地址：bilivideo.com 系（upos 签名，签名
 * 只认 uparams、与主机名无关，故可在各镜像间互换）与 akamaized.net（Akamai
 * 自己的 hdnts 签名，换主机即失效）。
 *
 * 本脚本只做一件事：在 playurl 里挑出那条 upos 签名的 bilivideo 地址，把它的
 * 主机换成你指定的镜像（TARGET_HOST），并顶到 baseUrl 首选——播放器于是从你
 * 选的节点取流。绝不把 akam 的 hdnts 地址套到 bilivideo 主机上（那样会 403）。
 *
 * 为什么不在分片(.m4s)请求层换主机：那些地址带 host 相关的签名，裸换主机会
 * 401/403；只有在 playurl 层换 upos 系地址才安全。
 */
(() => {
  'use strict'

  // 【已并入 BiliKit-Web Core】检测到 Core 在运行则提示本独立脚本可卸载（一次性、可关闭；不影响本脚本功能）。
  if (window.top === window.self) setTimeout(() => {
    try {
      if (Date.now() - (Number(localStorage.getItem('bilikit:alive.core')) || 0) > 15000) return
      const K = 'bilikit:dismiss.legacy-cdn-pick'
      if (localStorage.getItem(K)) return
      const b = document.createElement('div')
      b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483600;max-width:300px;padding:10px 34px 10px 14px;border-radius:10px;background:rgba(22,23,28,.96);color:#e3e5e7;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)'
      b.innerHTML = '「CDN 优选」已并入 <b style="color:#fb7299">BiliKit-Web Core</b>，本独立脚本可卸载。<a href="https://github.com/shiinayane/BiliKit-Web" target="_blank" rel="noopener" style="color:#fb7299;text-decoration:none">详情</a>'
      const x = document.createElement('span')
      x.textContent = '✕'
      x.style.cssText = 'position:absolute;top:7px;right:11px;cursor:pointer;opacity:.55'
      x.onclick = () => { try { localStorage.setItem(K, '1') } catch (e) {} b.remove() }
      b.appendChild(x)
      ;(document.body || document.documentElement).appendChild(b)
    } catch (e) {}
  }, 2500)

  // 不设顶层窗口守卫：本脚本无 UI、纯按帧改写请求，需要在子框架里也跑——
  // float 抽屉(同源 iframe 载视频页) 与番剧 player.bilibili.com 播放器都靠它。
  // 单例守卫按 window 计，每个框架各一份，互不冲突。
  if (window.__BILIKIT_CDN_PICK__) return
  window.__BILIKIT_CDN_PICK__ = true

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */
  // 想换的镜像主机（裸域名）。换节点就改这一行、刷新即可。置空 '' = 关闭。
  // 2026-06 日本 10 条视频流实测（中位 Mbps / 最低 / 成功率，越高越稳）：
  //   hwb 38.1 / 15.4 / 10·10 ★首选   upcdnbda2 33.8 / 28.1 / 10·10（地板最高）
  //   hw 33.6 / 24.6 / 10·10   bos 31.5 / 23.4 / 10·10   alib 26.1
  //   ali 中位27.3 但仅 8/10 成功，淘汰；海外镜像在视频上全废：cosov 6.4(最低1.7)、aliov 9.2
  //   —— 卡顿主要发生在冷门/新视频(回源)，大陆华为/百度系完胜；延迟会骗人。
  //      复测/换样本见 test/cdn-benchmark.md（务必用视频流，音频测不准）
  const TARGET_HOST = 'upos-sz-mirrorhwb.bilivideo.com'
  // 备用镜像：主镜像打嗝时回退至此，仍是大陆镜像、绝不回 akam/cosov。按地板高低排。
  const BACKUP_HOSTS = ['upos-sz-upcdnbda2.bilivideo.com', 'upos-sz-mirrorhw.bilivideo.com']

  const DEBUG = false // 调参期改 true 看改写日志
  const log = (...a) => { if (DEBUG) console.log('[CDN优选]', ...a) }

  if (!TARGET_HOST) { log('TARGET_HOST 为空，未启用'); return }

  // upos 系（签名与主机无关，可安全换镜像）；akamaized 不在此列，绝不往上套。
  // 锚定到「//主机/」形态：既排除「查询串里恰含 bilivideo」的误判，又与 swapHost
  // 的替换形态严格对齐（两者都只认 //host/ 开头），不会出现一个命中一个空转。
  const UPOS_RE = /^(?:https?:)?\/\/[^/]*\.(?:bilivideo\.com|acgvideo\.(?:com|cn))\//
  const isUpos = (u) => typeof u === 'string' && UPOS_RE.test(u)
  const swapHost = (u, host) => u.replace(/^(?:https?:)?\/\/[^/]+\//, `https://${host}/`)

  let rewriteCount = 0

  // 把一条 dash 流（或 durl 段）整体钉到大陆镜像：主 = TARGET_HOST，
  // 备份列表整列重建为 [TARGET, ...BACKUP]，把 akam/cosov 彻底清出——
  // 否则主镜像一回源打嗝，播放器就轮到备份里的 akam/cosov，url 反复横跳。
  function fixEntry(e) {
    if (!e || typeof e !== 'object') return false
    const cands = []
    for (const k of ['baseUrl', 'base_url', 'url']) if (typeof e[k] === 'string') cands.push(e[k])
    for (const k of ['backupUrl', 'backup_url']) if (Array.isArray(e[k])) cands.push(...e[k].filter((x) => typeof x === 'string'))
    const upos = cands.find(isUpos)
    if (!upos) return false // 没有任何 upos 地址（只有 akam）→ 不动（换主机会 403）
    const primary = swapHost(upos, TARGET_HOST)
    const backups = BACKUP_HOSTS.map((h) => swapHost(upos, h))
    for (const k of ['baseUrl', 'base_url', 'url']) if (typeof e[k] === 'string') e[k] = primary
    // 只要原来有备份列表就整列替换为「目标 + 大陆备用」，不再保留任何 akam/cosov
    if (Array.isArray(e.backupUrl)) e.backupUrl = [primary, ...backups]
    if (Array.isArray(e.backup_url)) e.backup_url = [primary, ...backups]
    rewriteCount++
    return true
  }

  // 改写整个 playurl 对象（兼容网页 data / 番剧 result 两种外层）
  function rewritePlayurl(root) {
    if (!root || typeof root !== 'object') return false
    if (root.code !== undefined && root.code !== 0) return false
    const d = root.data || root.result || root
    if (!d || typeof d !== 'object') return false
    let hit = false
    const dash = d.dash
    if (dash) {
      for (const list of [dash.video, dash.audio, dash.dolby && dash.dolby.audio]) {
        if (Array.isArray(list)) list.forEach((e) => { if (fixEntry(e)) hit = true })
      }
      if (dash.flac && dash.flac.audio && fixEntry(dash.flac.audio)) hit = true
    }
    if (Array.isArray(d.durl)) d.durl.forEach((e) => { if (fixEntry(e)) hit = true }) // 非 dash 的 mp4
    return hit
  }

  const PLAYURL_PATHS = [
    '/x/player/wbi/playurl', '/x/player/playurl',
    '/pgc/player/web/playurl', '/pgc/player/web/v2/playurl', '/pgc/player/api/playurl',
    '/pugv/player/web/playurl',
  ]
  const isPlayurl = (u) => typeof u === 'string' && PLAYURL_PATHS.some((p) => u.includes(p))

  /* ------------------------------------------------------------------ *
   * 一、首帧：window.__playinfo__（服务端内联，早于任何接口）
   * ------------------------------------------------------------------ */
  let playinfo
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get: () => playinfo,
      set: (v) => {
        try { if (rewritePlayurl(v)) log('__playinfo__ 改写', TARGET_HOST) } catch (_) {}
        playinfo = v
      },
    })
  } catch (_) {}

  /* ------------------------------------------------------------------ *
   * 二、换片/切档：fetch 与 XHR 的 playurl 响应
   * 已知限制：只 hook 主线程；若 B 站某天把 playurl 移进 Web Worker 取，
   * 本脚本会失效（需 Worker/Blob 注入，太重，暂不做）。实测当前未走 worker。
   * ------------------------------------------------------------------ */
  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = async function (input, init) {
      // input 可能是字符串 / Request / URL 对象，统一取出 URL 字符串
      const url = typeof input === 'string' ? input : (input && input.url) || String(input || '')
      const resp = await origFetch.apply(this, arguments)
      if (!isPlayurl(url)) return resp
      try {
        const text = await resp.clone().text()
        const obj = JSON.parse(text)
        if (rewritePlayurl(obj)) {
          log('fetch playurl 改写', TARGET_HOST)
          // 重建响应：剥掉 content-length / content-encoding——正文已解码且长度变了，
          // 照抄会让这俩头撒谎，可能导致消费方按 gzip 重解或按旧长度截断。
          const headers = new Headers(resp.headers)
          headers.delete('content-length')
          headers.delete('content-encoding')
          return new Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers })
        }
      } catch (_) {}
      return resp
    }
  }

  const OX = window.XMLHttpRequest
  if (OX) {
    class X extends OX {
      open(method, url) {
        this.__cdnUrl = url
        return super.open.apply(this, arguments)
      }
      get responseText() {
        // responseType 非文本时 super.responseText 按规范会抛——原样交还原生，别插手
        const rt = this.responseType
        if (rt !== '' && rt !== 'text') return super.responseText
        return this.__cdnText(super.responseText)
      }
      get response() {
        const r = super.response
        if (this.readyState !== 4 || !isPlayurl(this.__cdnUrl)) return r
        if (typeof r === 'string') return this.__cdnText(r)
        // responseType='json'：r 是已解析对象，就地改写（同一缓存对象，后续读取保留）
        if (r && typeof r === 'object') { try { if (rewritePlayurl(r)) log('xhr(json) playurl 改写', TARGET_HOST) } catch (_) {} }
        return r
      }
      __cdnText(raw) {
        if (this.readyState !== 4 || typeof raw !== 'string' || !isPlayurl(this.__cdnUrl)) return raw
        try {
          const obj = JSON.parse(raw)
          if (rewritePlayurl(obj)) { log('xhr playurl 改写', TARGET_HOST); return JSON.stringify(obj) }
        } catch (_) {}
        return raw
      }
    }
    window.XMLHttpRequest = X
  }

  log('已启用 →', TARGET_HOST)
})()
