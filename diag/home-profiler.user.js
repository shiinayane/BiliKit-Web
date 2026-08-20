// ==UserScript==
// @name         BiliKit-Web · 首页性能探针（诊断用）
// @name:en      BiliKit-Web · Homepage Profiler (diagnostic)
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.2.0
// @description  只观测、不改写行为：统计 B 站首页的定时器密度 / 长任务 / 网络埋点 / DOM 增长，用于决定优化方向。测原生基线时请先关掉 BiliKit-Web Feed（和 Core）。
// @author       shiinayane
// @match        *://www.bilibili.com/
// @match        *://www.bilibili.com/?*
// @match        *://www.bilibili.com/index.html*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 设计原则：诊断探针只「数」，不「改」。
 *  - 包裹 setTimeout/setInterval/clearInterval/fetch/XHR/sendBeacon，但一律原样透传
 *    调用原生实现、返回原生结果——不改任何时序/参数，故不影响页面本身，也不会和
 *    其它脚本打架。包裹只为在旁边加一个计数器和调用点归类。
 *  - 长任务 / 资源用 PerformanceObserver 被动观察。
 *  - performance.memory 仅 Chrome 有；Safari 下自动跳过（用 DOM 节点数当内存代理）。
 *
 * 用法：
 *  1) 测原生基线 → 先在 Userscripts 关掉 BiliKit-Web Feed / Core，刷新首页。
 *  2) 右下角出现「性能探针」面板，实时滚动数字；刷一会儿（滚动几屏、停留 30~60s）。
 *  3) 点面板「打印报告」或控制台执行 __biliProfReport()，把 console 里的表格截图/复制给我。
 *  4) 想对比：开 Feed 再来一遍，两份报告对照。
 */
(() => {
  'use strict';

  if (window.__BILI_PROFILER__) return;
  window.__BILI_PROFILER__ = true;

  const T0 = performance.now();
  const now = () => performance.now();

  // ---- 埋点/上报域名或路径的经验判断（仅用于把网络请求标红提示，不拦截） ----
  const BEACON_HINT = [
    'data.bilibili.com', 'mcbas', 'webase', '/x/report', '/x/click-interface',
    '/x/internal/', 'api.bilibili.com/x/web-goblin', 'cm.bilibili.com', 'chat.bilibili.com',
    '/x/frontend/', 'api.live.bilibili.com/xlive/web-ucenter', 'boss.hdslb.com',
  ];
  const looksLikeBeacon = (url) => BEACON_HINT.some((h) => url.includes(h));

  /* ================= 定时器计数（透传，不改时序） ================= */
  const stat = {
    setTimeoutCalls: 0,
    setIntervalCalls: 0,
    clearIntervalCalls: 0,
    activeIntervals: new Set(),
  };
  // 按「调用点」归类：谁在狂设定时器。key 取一段代表性栈帧。
  const timerSites = new Map(); // key -> {kind, count, delays:Set}

  function callSite() {
    try {
      const lines = (new Error().stack || '').split('\n');
      // 跳过 Error 头 + 本包裹层，取第一条页面自己的栈帧
      for (let i = 2; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l && !l.includes('home-profiler')) return l.replace(/^at\s+/, '').slice(0, 140);
      }
    } catch (_) {}
    return '(unknown)';
  }
  function record(kind, delay) {
    const key = callSite();
    let e = timerSites.get(key);
    if (!e) { e = { kind, count: 0, delays: new Set() }; timerSites.set(key, e); }
    e.count++;
    if (typeof delay === 'number') e.delays.add(delay | 0);
  }

  const _setTimeout = window.setTimeout.bind(window);
  const _setInterval = window.setInterval.bind(window);
  const _clearInterval = window.clearInterval.bind(window);

  window.setTimeout = function (fn, delay, ...args) {
    stat.setTimeoutCalls++;
    record('timeout', delay);
    return _setTimeout(fn, delay, ...args);
  };
  window.setInterval = function (fn, delay, ...args) {
    stat.setIntervalCalls++;
    record('interval', delay);
    const id = _setInterval(fn, delay, ...args);
    stat.activeIntervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    stat.clearIntervalCalls++;
    stat.activeIntervals.delete(id);
    return _clearInterval(id);
  };

  /* ================= 网络计数（透传） ================= */
  const net = new Map(); // host -> {count, beacon}
  let beaconCount = 0, fetchCount = 0, xhrCount = 0;
  const beaconUrls = new Map(); // url(截断) -> count

  function noteNet(url) {
    try {
      const u = new URL(url, location.href);
      const host = u.host;
      let e = net.get(host);
      if (!e) { e = { count: 0, beacon: false }; net.set(host, e); }
      e.count++;
      if (looksLikeBeacon(u.href)) {
        e.beacon = true;
        const k = (host + u.pathname).slice(0, 90);
        beaconUrls.set(k, (beaconUrls.get(k) || 0) + 1);
      }
    } catch (_) {}
  }

  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      fetchCount++;
      try { noteNet(typeof input === 'string' ? input : input.url); } catch (_) {}
      return _fetch.call(this, input, init);
    };
  }
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrCount++;
    try { noteNet(url); } catch (_) {}
    return _open.call(this, method, url, ...rest);
  };
  if (navigator.sendBeacon) {
    const _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      beaconCount++;
      try { noteNet(url); } catch (_) {}
      return _sb(url, data);
    };
  }

  /* ================= 长任务（被动观察，Safari 可能不支持） ================= */
  const longtasks = { count: 0, total: 0, max: 0 };
  let longtaskSupported = false;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longtasks.count++;
        longtasks.total += e.duration;
        if (e.duration > longtasks.max) longtasks.max = e.duration;
      }
    });
    po.observe({ type: 'longtask', buffered: true });
    longtaskSupported = true;
  } catch (_) { /* Safari 旧版无 longtask */ }

  /* ================= DOM 节点数 & 内存 采样 ================= */
  const samples = []; // {t, nodes, heapMB}
  const hasMem = !!(performance.memory && performance.memory.usedJSHeapSize);
  function sample() {
    const nodes = document.getElementsByTagName('*').length;
    const heapMB = hasMem ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    samples.push({ t: +((now() - T0) / 1000).toFixed(1), nodes, heapMB });
    updatePanel(nodes, heapMB);
  }

  /* ================= 报告 =================
   * 关键：Safari 的 console.table 在「复制控制台文本」时会序列化成空行，
   * 所以这里改成纯文本块——一次 console.log 一整段可复制文本，并尝试写入剪贴板。 */
  function pad(s, n) { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(0, n - s.length)); }
  function ttable(rows) {
    if (!rows.length) return '（无数据）';
    const keys = Object.keys(rows[0]);
    const w = {};
    keys.forEach((k) => { w[k] = k.length; });
    rows.forEach((r) => keys.forEach((k) => { w[k] = Math.max(w[k], String(r[k] == null ? '' : r[k]).length); }));
    const head = keys.map((k) => pad(k, w[k])).join('  ');
    const sep = keys.map((k) => '-'.repeat(w[k])).join('  ');
    const body = rows.map((r) => keys.map((k) => pad(r[k], w[k])).join('  ')).join('\n');
    return head + '\n' + sep + '\n' + body;
  }

  function buildText() {
    const secs = (now() - T0) / 1000;
    const L = [];
    L.push('===== BiliKit-Web 首页性能探针报告 =====');
    L.push(`运行 ${secs.toFixed(1)}s ｜ Feed/Core ${document.querySelector('.bk-feed-grid') ? '疑似开启' : '未检测到'} ｜ UA ${navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') ? 'Safari' : '其它'}`);

    L.push('\n— 定时器 —');
    L.push(ttable([
      { 项: 'setInterval 创建总数', 值: stat.setIntervalCalls },
      { 项: '当前活跃 interval', 值: stat.activeIntervals.size },
      { 项: 'setTimeout 创建总数', 值: stat.setTimeoutCalls },
      { 项: 'setTimeout 频率/s', 值: +(stat.setTimeoutCalls / secs).toFixed(1) },
      { 项: 'clearInterval 次数', 值: stat.clearIntervalCalls },
    ]));

    L.push('\n定时器调用点 Top12（谁在狂设）');
    L.push(ttable([...timerSites.entries()]
      .sort((a, b) => b[1].count - a[1].count).slice(0, 12)
      .map(([site, e]) => ({ 类型: e.kind, 次数: e.count, 间隔ms: [...e.delays].slice(0, 5).join(','), 调用点: site }))));

    L.push('\n— 网络 —');
    L.push(ttable([{ fetch: fetchCount, XHR: xhrCount, sendBeacon: beaconCount }]));
    L.push('\n按域名（★=疑似埋点/上报，可拦）');
    L.push(ttable([...net.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([host, e]) => ({ 域名: host, 请求数: e.count, 疑似埋点: e.beacon ? '★' : '' }))));
    if (beaconUrls.size) {
      L.push('\n疑似埋点路径 Top15');
      L.push(ttable([...beaconUrls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([url, c]) => ({ 路径: url, 次数: c }))));
    }

    L.push('\n— 长任务 —');
    L.push(longtaskSupported
      ? ttable([{
          '长任务(>50ms)': longtasks.count,
          累计阻塞ms: +longtasks.total.toFixed(0),
          最长ms: +longtasks.max.toFixed(0),
          平均ms: longtasks.count ? +(longtasks.total / longtasks.count).toFixed(0) : 0,
        }])
      : '本浏览器不支持 longtask 观测（Safari 常见）→ 看 DOM 增长判断。');

    L.push('\n— DOM 节点 / 内存 采样（最近20）—');
    L.push(ttable(samples.slice(-20)));
    if (!hasMem) L.push('（Safari 无 performance.memory，heapMB 空；看 nodes 增长即可）');

    L.push('\n把这一整段复制给我即可。');
    return L.join('\n');
  }

  function report() {
    const text = buildText();
    console.log(text); // 单段纯文本，可整段选中复制
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {}, () => {});
        copied = true;
      }
    } catch (_) {}
    return copied ? '（已尝试复制到剪贴板；若未成功，直接选中上面这段文本复制）' : text;
  }
  window.__biliProfReport = report;
  window.__biliProfText = buildText;

  /* ================= 悬浮面板 ================= */
  let panel, body;
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483600;width:210px;padding:10px 12px;border-radius:10px;background:rgba(18,19,24,.94);color:#e3e5e7;font:12px/1.6 -apple-system,"PingFang SC",monospace;box-shadow:0 6px 24px rgba(0,0,0,.45);backdrop-filter:blur(6px)';
    panel.innerHTML = '<div style="font-weight:700;color:#fb7299;margin-bottom:4px">⚡ 性能探针</div><div class="bp-body"></div>';
    const btn = document.createElement('button');
    btn.textContent = '复制报告（→剪贴板+console）';
    btn.style.cssText = 'margin-top:8px;width:100%;padding:5px;border:0;border-radius:7px;background:#fb7299;color:#fff;font-weight:600;cursor:pointer';
    btn.onclick = () => {
      report();
      const t = btn.textContent;
      btn.textContent = '✓ 已复制（也在 console）';
      _setTimeout(() => { btn.textContent = t; }, 1600);
    };
    panel.appendChild(btn);
    body = panel.querySelector('.bp-body');
    (document.body || document.documentElement).appendChild(panel);
  }
  function updatePanel(nodes, heapMB) {
    if (!body) return;
    const secs = ((now() - T0) / 1000).toFixed(0);
    body.innerHTML =
      `运行 ${secs}s<br>` +
      `interval 活跃 <b>${stat.activeIntervals.size}</b>（建 ${stat.setIntervalCalls}）<br>` +
      `setTimeout <b>${stat.setTimeoutCalls}</b>（${(stat.setTimeoutCalls / (secs || 1)).toFixed(1)}/s）<br>` +
      `请求 fetch ${fetchCount} · XHR ${xhrCount}<br>` +
      `beacon <b>${beaconCount}</b>　埋点域 ${[...net.values()].filter((e) => e.beacon).length}<br>` +
      (longtaskSupported ? `长任务 <b>${longtasks.count}</b> · 阻塞 ${longtasks.total.toFixed(0)}ms<br>` : `长任务：不支持<br>`) +
      `DOM 节点 <b>${nodes}</b>` + (heapMB != null ? ` · ${heapMB}MB` : '');
  }

  /* ================= 启动 ================= */
  // 面板自己的采样定时器走原生 _setInterval，避免把探针自己的定时器算进统计
  const startSample = () => { buildPanel(); sample(); _setInterval(sample, 2000); };
  if (document.body) startSample();
  else document.addEventListener('DOMContentLoaded', startSample);
})();
