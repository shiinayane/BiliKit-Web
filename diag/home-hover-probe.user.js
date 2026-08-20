// ==UserScript==
// @name         BiliKit-Web · 原生 hover 预览探针（诊断用）
// @name:en      BiliKit-Web · Native Hover Probe (diagnostic)
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.2.0
// @description  只观测、不改写：抓 B 站原生首页卡片 hover 时发的请求（playurl/view/videoshot）、返回的是 durl(渐进mp4)还是 dash(MSE)、流走哪个主机，以及 <video> 的真实 src。用于搞清原生「秒开真视频」的做法。测时请关掉 BiliKit-Web Feed。
// @author       shiinayane
// @match        *://www.bilibili.com/
// @match        *://www.bilibili.com/?*
// @match        *://www.bilibili.com/index.html*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 关键信号：
 *  - hover 后有没有 /playurl 请求？qn / fnval 是多少？
 *  - 没有先打 /view、/pagelist → 说明 cid 已在 feed 数据里（省一次往返，是「快」的主因之一）。
 *  - playurl 返回 durl(单文件 mp4) 还是 dash(分片)？durl→渐进直播、起播最快。
 *  - <video> 的 currentSrc：http mp4 = 渐进；blob: = MSE(dash 喂分片)。这条最能一锤定音。
 *  - 从「鼠标进卡」到「playurl 请求 / video 起播」各隔多久。
 * 全程只包裹 fetch/XHR 计数与旁听媒体事件，原样透传，不改页面行为。
 */
(() => {
  'use strict';
  if (window.__BILI_HOVER_PROBE__) return;
  window.__BILI_HOVER_PROBE__ = true;

  const T0 = performance.now();
  const t = () => ((performance.now() - T0) / 1000).toFixed(2);
  const hostOf = (u) => { try { return new URL(u, location.href).host; } catch { return '?'; } };

  const events = []; // {t, kind, detail}
  let lastHoverAt = 0, hoverCount = 0;
  const log = (kind, detail) => {
    const sinceHover = lastHoverAt ? `+${((performance.now() - lastHoverAt) / 1000).toFixed(2)}s后hover` : '';
    events.push({ t: t(), kind, detail, sinceHover });
    if (events.length > 400) events.shift();
    updatePanel();
  };

  const INTEREST = [
    { re: /\/playurl/, tag: 'playurl' },
    { re: /\/x\/web-interface\/view|\/x\/player\/pagelist|\/x\/player\/wbi\/v2/, tag: 'view/cid' },
    { re: /\/videoshot/, tag: 'videoshot(雪碧图)' },
    { re: /\/feed\/index|\/top\/feed\/rcmd/, tag: 'feed' },
  ];
  const tagOf = (url) => { for (const i of INTEREST) if (i.re.test(url)) return i.tag; return null; };

  // 媒体分段主机：原生 MSE 预览抓分段就走这些。关键看它对冷门视频的分段请求「状态码」——
  // 若原生也能拿到 206，说明差别在请求方式（浏览器 fetch vs 我们的 GM）；若原生对冷门根本不发/也失败，说明冷门本就没预览。
  const isMedia = (u) => /\/\/[^/]*\.(bilivideo\.com|akamaized\.net)\//i.test(u) || /mcdn\.bilivideo|szbdyd\.com|\/v1\/resource\//i.test(u);
  const mediaHost = (u) => { let h = hostOf(u); if (/\/v1\/resource\//.test(u)) h += '[PCDN]'; else if (/mcdn/.test(h)) h += '[mcdn]'; return h; };
  function noteMedia(url, status, ranged) {
    log('seg', `${mediaHost(url)} → ${status}${status === 206 ? ' ✓' : status === 403 ? ' ✗403' : ''}${ranged ? ' [Range]' : ''}`);
  }
  const hasRange = (init) => { try { if (!init || !init.headers) return false; const h = init.headers; return !!(h.get ? h.get('Range') : (h.Range || h.range)); } catch { return false; } };

  function summarizePlayurl(url, text) {
    const s = {};
    s.qn = (url.match(/[?&]qn=(\d+)/) || [])[1] || '(无)';
    s.fnval = (url.match(/[?&]fnval=(\d+)/) || [])[1] || '(无)';
    s.host = hostOf(url).includes('app.bilibili') ? 'app' : 'web';
    try {
      const j = JSON.parse(text);
      const d = j.data || j.result || {};
      s.quality = d.quality;
      if (Array.isArray(d.durl) && d.durl.length) { s.type = 'durl(渐进mp4)'; s.stream = hostOf(d.durl[0].url); }
      else if (d.dash) { const v = (d.dash.video || [])[0]; s.type = 'dash(分片/MSE)'; s.stream = v ? hostOf(v.baseUrl || v.base_url) : '?'; s.vid = v && v.id; }
      else s.type = '(未见 durl/dash)';
    } catch { s.type = '解析失败/非JSON'; }
    return s;
  }

  function note(url, getText) {
    const tag = tagOf(url);
    if (!tag) return;
    if (tag === 'playurl') {
      Promise.resolve(getText()).then((text) => {
        const s = summarizePlayurl(url, text || '');
        log('playurl', `源=${s.host} qn=${s.qn} fnval=${s.fnval} → ${s.type} quality=${s.quality ?? '?'} 流主机=${s.stream ?? '?'}${s.vid ? ' vid=' + s.vid : ''}`);
      }).catch(() => log('playurl', '(响应读取失败) ' + url.slice(0, 80)));
    } else {
      log(tag, url.replace(/access_key=[^&]*/, 'access_key=***').slice(0, 110));
    }
  }

  // fetch 透传 + 旁读
  const oFetch = window.fetch;
  if (oFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = oFetch.apply(this, arguments);
      if (tagOf(url)) p.then((r) => note(url, () => r.clone().text())).catch(() => {});
      else if (isMedia(url)) { const rg = hasRange(init); p.then((r) => noteMedia(url, r.status, rg)).catch(() => noteMedia(url, 'ERR', rg)); }
      return p;
    };
  }
  // XHR 透传 + 旁读
  const OX = window.XMLHttpRequest;
  if (OX) {
    class X extends OX {
      __u = '';
      __rg = false;
      open(m, u, ...r) { this.__u = u; return super.open(m, u, ...r); }
      setRequestHeader(k, v) { if (String(k).toLowerCase() === 'range') this.__rg = true; return super.setRequestHeader(k, v); }
      send(b) {
        if (tagOf(this.__u)) this.addEventListener('load', () => { try { note(this.__u, () => this.responseText); } catch {} });
        else if (isMedia(this.__u)) this.addEventListener('loadend', () => { try { noteMedia(this.__u, this.status, this.__rg); } catch {} });
        return super.send(b);
      }
    }
    window.XMLHttpRequest = X;
  }

  // 媒体事件旁听（捕获阶段，媒体事件不冒泡）：video 起播 / 换源
  const seenSrc = new Set();
  const onMedia = (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const src = v.currentSrc || v.src || '';
    if (!src || seenSrc.has(e.type + src)) return;
    seenSrc.add(e.type + src);
    const kind = src.startsWith('blob:') ? 'blob:(MSE/dash)' : src.startsWith('http') ? 'http直链(渐进?)' : src.slice(0, 12);
    log('video.' + e.type, `${kind} 主机=${src.startsWith('http') ? hostOf(src) : '-'} w=${v.videoWidth || '?'}`);
  };
  for (const ev of ['loadstart', 'playing', 'play']) document.addEventListener(ev, onMedia, true);

  // 卡片 hover 计时锚点（用于把请求/起播与「进卡」对齐）
  document.addEventListener('mouseover', (e) => {
    const card = (e.target instanceof Element) && e.target.closest('.bili-video-card, .feed-card, .bili-feed-card');
    if (card && card !== window.__lastCard) { window.__lastCard = card; lastHoverAt = performance.now(); hoverCount++; log('hover', '进卡 #' + hoverCount); }
  }, true);

  /* ---- 文本报告（规避 Safari console.table 复制成空行） ---- */
  function buildText() {
    const L = [];
    L.push('===== BiliKit-Web 原生 hover 预览探针 =====');
    L.push(`运行 ${t()}s ｜ hover 卡片 ${hoverCount} 次 ｜ Feed ${document.querySelector('.bk-feed-grid') ? '疑似开启(请关掉重测)' : '未检测到✓'}`);
    L.push('\n事件时间线（按发生顺序）：');
    for (const e of events) L.push(`[${e.t}s] ${e.kind.padEnd(16)} ${e.detail}`);
    L.push('\n判读要点：playurl 若 fnval 小/返回 durl 且 <video> 是 http 直链 → 原生走「渐进mp4秒开」；');
    L.push('若 <video> 是 blob: → 走 MSE/dash。hover 前若无 view/cid 请求 → cid 已在 feed 数据里。');
    L.push('把这一整段复制给我。');
    return L.join('\n');
  }
  function report() {
    const text = buildText();
    console.log(text);
    try { navigator.clipboard && navigator.clipboard.writeText(text); } catch {}
    return text;
  }
  window.__biliHoverReport = report;

  /* ---- 悬浮面板 ---- */
  let panel, body;
  function build() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483600;width:250px;padding:10px 12px;border-radius:10px;background:rgba(18,19,24,.94);color:#e3e5e7;font:12px/1.55 -apple-system,"PingFang SC",monospace;box-shadow:0 6px 24px rgba(0,0,0,.45)';
    panel.innerHTML = '<div style="font-weight:700;color:#fb7299;margin-bottom:4px">🎬 hover 探针</div><div class="hp-body"></div>';
    const btn = document.createElement('button');
    btn.textContent = '复制报告（→剪贴板+console）';
    btn.style.cssText = 'margin-top:8px;width:100%;padding:5px;border:0;border-radius:7px;background:#fb7299;color:#fff;font-weight:600;cursor:pointer';
    btn.onclick = () => { report(); const o = btn.textContent; btn.textContent = '✓ 已复制'; setTimeout(() => btn.textContent = o, 1500); };
    panel.appendChild(btn);
    body = panel.querySelector('.hp-body');
    (document.body || document.documentElement).appendChild(panel);
    updatePanel();
  }
  function updatePanel() {
    if (!body) return;
    const last = events.slice(-6).map((e) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">[${e.t}s] <b>${e.kind}</b> ${e.detail}</div>`).join('');
    body.innerHTML = `hover ${hoverCount} 次 · 事件 ${events.length}<br>` + last;
  }
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
