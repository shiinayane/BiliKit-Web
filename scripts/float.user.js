// ==UserScript==
// @name         BiliKit-Web · 浮窗抽屉
// @name:en      BiliKit-Web · Float
// @namespace    https://github.com/shiinayane/BiliKit-Web
// @version      0.18.12
// @description    ⚠️【已停止单独维护，建议改用 BiliKit-Web 套件 Core + Feed】点击 B 站视频，在页内抽屉中播放，而非跳转新标签页或当前页面。
// @description:en Click a Bilibili video to play it in an in-page drawer instead of opening a new tab or navigating away.
// @author       shiinayane
// @match        *://www.bilibili.com/*
// @match        *://search.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @run-at       document-idle
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/581920/BiliKit%20%C2%B7%20%E6%B5%AE%E7%AA%97%E6%8A%BD%E5%B1%89.user.js
// @updateURL https://update.greasyfork.org/scripts/581920/BiliKit%20%C2%B7%20%E6%B5%AE%E7%AA%97%E6%8A%BD%E5%B1%89.meta.js
// ==/UserScript==

(function () {
  'use strict'

  // 仅在顶层窗口运行：抽屉内的 iframe 同样是 www.bilibili.com，
  // 不加这个守卫脚本会注入到 iframe 里造成递归拦截。
  if (window.top !== window.self) return

  // 单例守卫：防止脚本被重复安装/注入(如改名后旧版未卸载)导致「点一下开两个抽屉」。
  if (window.__BILIKIT_FLOAT__) return
  window.__BILIKIT_FLOAT__ = true

  /* ------------------------------------------------------------------ *
   * 配置（可按需修改）
   * ------------------------------------------------------------------ */
  const CONFIG = {
    // 形态：'fullscreen' 全屏右滑入(推荐，左滑返回最自然) | 'modal' 居中大窗 | 'drawer-bottom' | 'drawer-right' | 'drawer-left'
    mode: 'fullscreen',
    zIndex: 2147483600, // 尽量盖过 B 站自身的弹层

    // 遮罩样式：'plain' 普通半透明遮罩(默认，省 GPU) | 'blur' 高斯模糊遮罩 | 'none' 无遮罩(背景页面完全可见，仍可点遮罩关闭)
    backdrop: 'plain',

    // 「新标签打开」行为：抽屉是「速看」，点此即「升级为完整观看」。
    newTabResumeTime: true, // 带上当前播放进度(?t=)，新标签无缝续播
    newTabClosesDrawer: true, // 打开后关闭抽屉，避免与新标签双重播放/双声

    // 沉浸/表现：iframe 同源，load 后直接操控播放器，无需参数中转。
    autoPlayInDrawer: true, // 进抽屉自动播放（被浏览器自动播放策略拦截时静默失败）
    hideHeaderInDrawer: true, // 隐藏 iframe 内 B 站顶栏，让播放器占满
    headerSelectors: ['#biliMainHeader', '.bili-header'], // 顶栏选择器（按需增删）
    syncDrawerTheme: true, // 开着抽屉时切主题 → 切换 iframe 主题样式表(light/dark.css)实时跟随，无刷新不打断播放

    // 加载封面占位：点开瞬间用卡片封面铺底，避免黑屏、确认「点的就是它」
    coverPlaceholder: true,

    // 悬停预连接：悬停视频卡时预连接静态/接口主机（12s 节流），点开省去握手延迟
    preconnectOnHover: true,

    // 触控板横向滑动关闭：Safari 原生左滑返回对 SPA pushState 无效，且手势会落到 iframe 上，
    // 因此自行检测 wheel 横向位移来关闭抽屉。
    swipeToClose: true,
    swipeThreshold: 140, // 累计横向位移阈值(px)，越大越不易误触
    swipeBackDeltaXSign: -1, // 「返回」对应的 deltaX 方向：-1=向右滑(macOS 自然滚动)；若方向相反改成 1

    // 抽屉内净化：iframe 与外层同源，由本脚本直接往视频页注入隐藏 CSS，
    // 不依赖广告屏蔽扩展。Safari / uBO Lite(MV3) 这类无法注入子框架的环境照样生效。
    cleanAds: true,
    // 要隐藏的广告位选择器（起步清单，按需增删）。
    // 找新规则最省事的办法：在「普通标签页」打开任一视频 → 打开 uBO 的 Logger，
    // 把里面以 ## 开头的 cosmetic 规则中的选择器抄到这里即可（等于把你 uBO 的规则搬过来）。
    adSelectors: [
      '.ad-report',
      '.video-page-special-card-small',
      '.video-page-game-card-small',
      '.slide-ad-exp',
      '.activity-m-v1',
      '.pop-live-small-mode',
      '.right-bottom-banner',
      '.eva-banner',
      '.gg-floor-module',
      '.video-card-ad-small',
    ],
  }

  // 命中即拦截的视频链接：普通视频 / 番剧播放页
  const VIDEO_LINK_RE = /\/(video\/(BV[\w]+|av\d+)|bangumi\/play\/)/i

  // 面板开合过渡时长(ms)。同时用于 CSS transition 与关闭后销毁 iframe 的延时，
  // 二者共用此常量避免「改一个忘另一个」。
  const TRANSITION_MS = 300

  // 跟手式滑动关闭：仅对「向右滑出」的形态启用(面板向右拖动跟手关闭)；其余形态用累计阈值回退。
  const FOLLOW_DRAG = CONFIG.mode === 'fullscreen' || CONFIG.mode === 'drawer-right'
  // 松手判定：超过此时长无 wheel 视为松手。手指停住不动时没有任何事件，无法区分
  // 「停顿」和「离开」，此值同时是拖拽中犹豫的容忍窗口，太小会把思考误判成松手。
  const DRAG_END_MS = 150
  // 启动死区(px)：累计横向位移小于此值不进入跟手（仿系统手势，微小滑动完全不动）；
  // 松手(DRAG_END_MS 无事件)后累计清零，多次微小滑动不会累加越过死区。
  const DRAG_START_PX = 32
  const DRAG_CLOSE_RATIO = 0.25 // 慢拖：拖过面板宽度的此比例即关闭，否则回弹（Safari 原生约 1/3）
  // 快速甩动即关（仿 Safari 两指返回的速度判定）：甩动速度峰值达到此值(px/ms)即关闭，
  // 即便没拖够 DRAG_CLOSE_RATIO。用真实速度而非单帧位移：wheel 事件按屏幕帧率派发，
  // 同样的甩动在 120Hz 屏上单帧位移只有 60Hz 的一半，按位移设阈值会随刷新率漂移。
  const DRAG_FLICK_VELOCITY = 2.4

  // 注入 iframe 的隐藏 CSS：广告位 +（可选）B 站顶栏。静态内容，启动时拼一次。
  const HIDE_SELECTORS = [
    ...(CONFIG.cleanAds && Array.isArray(CONFIG.adSelectors) ? CONFIG.adSelectors : []),
    ...(CONFIG.hideHeaderInDrawer && Array.isArray(CONFIG.headerSelectors) ? CONFIG.headerSelectors : []),
  ].filter(Boolean)
  const CLEAN_CSS = HIDE_SELECTORS.length ? `${HIDE_SELECTORS.join(',\n')} { display: none !important; }` : ''

  // 遮罩外观：按 CONFIG.backdrop 生成 .bfloat-backdrop 的背景与模糊。
  // blur=高斯模糊(modal/抽屉露出的页面、全屏拖拽露出的左侧更聚焦) | plain=普通半透明 | none=透明(无遮罩)
  const BACKDROP_VARIANTS = {
    blur: 'background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);',
    plain: 'background: rgba(0, 0, 0, 0.6);',
    none: 'background: transparent;',
  }
  const BACKDROP_CSS = BACKDROP_VARIANTS[CONFIG.backdrop] || BACKDROP_VARIANTS.plain

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */
  const STYLE = `
    .bfloat-backdrop {
      position: fixed;
      inset: 0;
      ${BACKDROP_CSS}
      opacity: 0;
      /* 关键：未打开时不拦截点击，否则透明遮罩会让整页点不动 */
      pointer-events: none;
      transition: opacity 0.25s ease;
      z-index: ${CONFIG.zIndex};
    }
    .bfloat-open .bfloat-backdrop { opacity: 1; pointer-events: auto; }

    /* ---- 面板公共样式 ---- */
    .bfloat-panel {
      position: fixed;
      display: flex;
      flex-direction: column;
      background: #18191c;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      /* 未打开时禁用点击，双保险 */
      pointer-events: none;
      transition: transform ${TRANSITION_MS}ms cubic-bezier(0.32, 0.72, 0, 1), opacity ${TRANSITION_MS}ms ease;
      z-index: ${CONFIG.zIndex + 1};
    }
    .bfloat-open .bfloat-panel { pointer-events: auto; }

    /* ---- 形态：全屏右滑入（左滑返回最自然） ---- */
    .bfloat-mode-fullscreen .bfloat-panel {
      top: 0;
      right: 0;
      width: 100%;
      height: 100%;
      border-radius: 0;
      transform: translateX(100%);
    }
    .bfloat-open.bfloat-mode-fullscreen .bfloat-panel { transform: translateX(0); }

    /* ---- 形态：居中大窗 ---- */
    .bfloat-mode-modal .bfloat-panel {
      top: 50%;
      left: 50%;
      width: min(94vw, 1500px);
      height: min(92vh, 900px);
      border-radius: 14px;
      transform: translate(-50%, -50%) scale(0.96);
      opacity: 0;
    }
    .bfloat-open.bfloat-mode-modal .bfloat-panel {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }

    /* ---- 形态：底部抽屉 ---- */
    .bfloat-mode-drawer-bottom .bfloat-panel {
      left: 0;
      bottom: 0;
      width: 100%;
      height: min(90vh, 880px);
      border-radius: 14px 14px 0 0;
      transform: translateY(100%);
    }
    .bfloat-open.bfloat-mode-drawer-bottom .bfloat-panel { transform: translateY(0); }

    /* ---- 形态：右侧抽屉 ---- */
    .bfloat-mode-drawer-right .bfloat-panel {
      top: 0;
      right: 0;
      height: 100%;
      width: min(1000px, 92vw);
      transform: translateX(100%);
    }
    .bfloat-open.bfloat-mode-drawer-right .bfloat-panel { transform: translateX(0); }

    /* ---- 形态：左侧抽屉 ---- */
    .bfloat-mode-drawer-left .bfloat-panel {
      top: 0;
      left: 0;
      height: 100%;
      width: min(1000px, 92vw);
      transform: translateX(-100%);
    }
    .bfloat-open.bfloat-mode-drawer-left .bfloat-panel { transform: translateX(0); }

    /* ---- iframe ---- */
    .bfloat-iframe {
      flex: 1 1 auto;
      width: 100%;
      border: none;
      background: #18191c;
    }

    /* ---- 右下角竖排浮动按钮 ---- */
    .bfloat-actions {
      position: absolute;
      right: 18px;
      bottom: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 6;
    }
    .bfloat-btn {
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.55;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: opacity 0.15s ease, background 0.15s ease, transform 0.1s ease;
    }
    .bfloat-btn:hover { opacity: 1; }
    .bfloat-btn:active { transform: scale(0.92); }
    .bfloat-btn-close:hover { background: #fb7299; }

    /* ---- 加载遮罩（盖住打开瞬间的黑/白闪烁） ---- */
    .bfloat-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #18191c;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
      z-index: 5;
    }
    .bfloat-panel.is-loading .bfloat-loading { opacity: 1; }
    /* 加载封面：模糊铺底，放大一点避免模糊边缘露白 */
    .bfloat-loading-cover {
      position: absolute;
      inset: 0;
      background-size: cover;
      background-position: center;
      filter: blur(24px) brightness(0.6);
      transform: scale(1.1);
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .bfloat-spinner {
      position: relative;
      width: 42px;
      height: 42px;
      border: 3px solid rgba(255, 255, 255, 0.2);
      border-top-color: #fb7299;
      border-radius: 50%;
      animation: bfloat-spin 0.8s linear infinite;
    }
    @keyframes bfloat-spin { to { transform: rotate(360deg); } }

    /* ---- 浅色系统主题：遮罩/底色自动转浅，避免与浅色 B 站页面的反差闪烁 ---- */
    /* 纯 CSS 跟随系统主题，零 JS、零 cookie 解析，最省资源 */
    @media (prefers-color-scheme: light) {
      .bfloat-panel,
      .bfloat-iframe,
      .bfloat-loading {
        background: #f4f4f5;
      }
      .bfloat-spinner {
        border-color: rgba(0, 0, 0, 0.12);
        border-top-color: #fb7299;
      }
    }
  `

  /* ------------------------------------------------------------------ *
   * 抽屉实例（懒创建，全局单例）
   * ------------------------------------------------------------------ */
  let els = null // 抽屉 DOM 单例 { root, backdrop, panel, iframe }
  let currentUrl = '' // 当前抽屉内视频地址（供「新标签打开」用）
  let isOpen = false // 抽屉是否打开（也作为 popstate / 手势的开关）
  let prevHtmlOverflow = '' // 锁定滚动前的 <html>/<body> overflow，关闭时还原
  let prevBodyOverflow = ''
  let loadingFallbackTimer = null // 加载遮罩兜底超时
  let swipeAccum = 0 // 横向滑动累计位移（非跟手形态的回退逻辑用）
  let swipeResetTimer = null // 滑动累计清零定时器
  let dragX = 0 // 跟手拖拽的横向位移（px）
  let dragging = false // 是否处于跟手拖拽中
  let dragPanelW = 0 // 拖拽开始时缓存的面板宽度（wheel 可达 ~120Hz，避免每帧读 offsetWidth）
  let dragPeakV = 0 // 本次拖拽中「返回方向」速度峰值(px/ms)，用于快速甩动判定
  let dragLastTs = 0 // 上一个有效 wheel 事件的时间戳，用于计算瞬时速度
  let dragEndTimer = null // 拖拽「松手」判定定时器
  let themeObserver = null // 监听宿主页 bili_dark 变化，开启期间镜像到抽屉
  let drawerThemeDark = false // 抽屉打开时记录的宿主深色态；仅在真正变化时才镜像到抽屉

  function injectStyleOnce() {
    if (document.getElementById('bfloat-style')) return
    const style = document.createElement('style')
    style.id = 'bfloat-style'
    style.textContent = STYLE
    document.head.appendChild(style)
  }

  function ensureDrawer() {
    if (els) return els

    injectStyleOnce()
    // 形态类挂在 <html> 上，与 bfloat-open 同元素，便于 .bfloat-open.bfloat-mode-x 组合选择
    document.documentElement.classList.add(`bfloat-mode-${CONFIG.mode}`)

    const root = document.createElement('div')
    root.className = 'bfloat-root'

    const backdrop = document.createElement('div')
    backdrop.className = 'bfloat-backdrop'
    backdrop.addEventListener('click', requestClose)

    const panel = document.createElement('div')
    panel.className = 'bfloat-panel'

    // 加载遮罩：盖住打开瞬间 iframe 的黑屏 → B 站白屏的闪烁
    const loading = document.createElement('div')
    loading.className = 'bfloat-loading'
    const loadingCover = document.createElement('div')
    loadingCover.className = 'bfloat-loading-cover'
    const spinner = document.createElement('div')
    spinner.className = 'bfloat-spinner'
    loading.append(loadingCover, spinner)

    // 右下角竖排浮动按钮（取代原顶栏）
    const actions = document.createElement('div')
    actions.className = 'bfloat-actions'

    const newTabBtn = document.createElement('button')
    newTabBtn.className = 'bfloat-btn bfloat-btn-newtab'
    newTabBtn.type = 'button'
    newTabBtn.title = '在新标签页打开（续播并关闭抽屉）'
    newTabBtn.textContent = '↗'
    newTabBtn.addEventListener('click', onNewTab)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'bfloat-btn bfloat-btn-close'
    closeBtn.type = 'button'
    closeBtn.title = '关闭 (Esc)'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', requestClose)

    actions.append(newTabBtn, closeBtn)
    panel.append(loading, actions)
    root.append(backdrop, panel)
    document.body.appendChild(root)

    // iframe 不在此创建：每次打开都新建一个，见 createIframe / openDrawer
    els = { root, backdrop, panel, loadingCover, iframe: null }
    return els
  }

  function createIframe(url) {
    const iframe = document.createElement('iframe')
    iframe.className = 'bfloat-iframe'
    iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write'
    iframe.allowFullscreen = true
    // 关键：插入 DOM 之前就以属性形式设好真实地址，
    // 使其首帧即导航到视频页，避免 about:blank 中转。
    // 否则广告屏蔽扩展的内容脚本可能漏注入到该子框架，
    // 表现为：网络拦截生效（计数增加），但元素隐藏规则不生效（广告仍显示）。
    iframe.setAttribute('src', url)
    // 每次加载（含 iframe 内部跳转）完成后：关闭加载遮罩 + 注入净化 CSS + 挂上滑动检测。
    // CSS 的 display:none 对加载后才动态插入的广告同样生效，无需额外监听 DOM。
    iframe.addEventListener('load', () => {
      setLoading(false)
      injectCleanup(iframe)
      // 手势 / 按键落在 iframe 上，必须把监听挂到子窗口（同源才行），
      // 否则焦点进入播放器后 ESC 和滑动手势都会失效。随 iframe 销毁自动回收。
      try {
        const win = iframe.contentWindow
        attachSwipe(win)
        win.addEventListener('keydown', onKeyDown, true)
      } catch (_) {
        // 跨域子页面无法访问，忽略
      }
      onDrawerIframeReady(iframe) // 自动播放 + 以当前宿主主题校正一次
    })
    return iframe
  }

  // iframe 已就绪且正在抽屉中展示时的动作：自动播放 + 以当前宿主主题校正一次
  function onDrawerIframeReady(iframe) {
    tryAutoPlay(iframe)
    if (CONFIG.syncDrawerTheme) {
      drawerThemeDark = hostIsDark()
      syncIframeTheme(drawerThemeDark)
    }
  }

  // 自动播放：播放器在 load 后才异步初始化 <video>，故轮询若干次直到出现再 play()
  function tryAutoPlay(iframe, attempt = 0) {
    if (!CONFIG.autoPlayInDrawer) return
    if (!isOpen || iframe !== els?.iframe || !iframe.isConnected) return // 抽屉已关 / 已换片 / 已移除 → 停止轮询
    let video
    try {
      video = iframe.contentDocument?.querySelector('video')
    } catch (_) {
      return // 跨域
    }
    if (video) {
      const p = video.play?.()
      if (p && typeof p.catch === 'function') p.catch(() => {}) // 被自动播放策略拦截则静默
      return
    }
    if (attempt < 20) window.setTimeout(() => tryAutoPlay(iframe, attempt + 1), 150) // 最多 ~3s
  }

  // 加载遮罩开关；带兜底超时，防止极端情况下 load 不触发导致遮罩不消失
  function setLoading(on) {
    if (!els) return
    els.panel.classList.toggle('is-loading', on)
    if (loadingFallbackTimer) {
      clearTimeout(loadingFallbackTimer)
      loadingFallbackTimer = null
    }
    if (on) {
      loadingFallbackTimer = window.setTimeout(() => setLoading(false), 6000)
    }
  }

  // 抽屉里是播放页：换肤 = 切换其主题样式表 <link> 的 href（light.css ↔ dark.css），
  // 与 B 站原生换肤同机制 → 无刷新、不打断播放。监听宿主页主题变化，镜像到抽屉 iframe。
  const THEME_LINK_RE = /\/bili-theme\/(light|dark)\.css/

  function hostIsDark() {
    const c = document.documentElement.classList
    return c.contains('bili_dark') || c.contains('night-mode')
  }

  // 把指定深色态应用到抽屉 iframe（换主题样式表 href + 标记类）。幂等，可重复调用。
  function syncIframeTheme(dark) {
    if (!els?.iframe) return
    try {
      const doc = els.iframe.contentDocument
      if (!doc) return
      const want = dark ? '/dark.css' : '/light.css'
      for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
        if (THEME_LINK_RE.test(link.href) && !link.href.includes(want)) {
          link.href = link.href.replace(/\/(light|dark)\.css/, want)
        }
      }
      doc.documentElement.classList.toggle('bili_dark', dark)
      doc.documentElement.classList.toggle('night-mode', dark)
    } catch (_) {
      // 跨域无法访问，忽略
    }
  }

  // 观察器回调：宿主页主题变化时镜像到抽屉。只在深/浅真的变了时才动作，
  // 避免我们自己的 bfloat-* 类、BG 等无关 class 误触发。
  function applyDrawerTheme() {
    if (!CONFIG.syncDrawerTheme || !isOpen || !els?.iframe) return
    const dark = hostIsDark()
    if (dark === drawerThemeDark) return
    drawerThemeDark = dark
    syncIframeTheme(dark)
  }

  function injectCleanup(iframe) {
    if (!CLEAN_CSS) return
    let doc
    try {
      doc = iframe.contentDocument // 跨域(如 space./t./m.bilibili.com)会抛错，直接跳过
    } catch (_) {
      return
    }
    if (!doc) return
    const STYLE_ID = 'bfloat-clean-style'
    if (doc.getElementById(STYLE_ID)) return // 已注入则跳过
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CLEAN_CSS
    ;(doc.head || doc.documentElement).appendChild(style)
  }

  /* ------------------------------------------------------------------ *
   * 打开 / 关闭
   * ------------------------------------------------------------------ */
  function openDrawer(url, coverSrc) {
    const refs = ensureDrawer()
    currentUrl = url

    // 封面占位：点开瞬间铺底，避免黑屏
    if (refs.loadingCover) {
      if (CONFIG.coverPlaceholder && coverSrc) {
        refs.loadingCover.style.backgroundImage = `url("${coverSrc}")`
        refs.loadingCover.style.opacity = '1'
      } else {
        refs.loadingCover.style.backgroundImage = ''
        refs.loadingCover.style.opacity = '0'
      }
    }

    // 每次打开（含换片）都重建 iframe，并在插入 DOM 前就设好真实 src，
    // 这样该子框架首帧即导航到视频页，扩展的内容脚本才能可靠注入。
    if (refs.iframe) refs.iframe.remove()
    const iframe = createIframe(url)
    refs.panel.appendChild(iframe)
    refs.iframe = iframe
    setLoading(true) // 显示加载遮罩，iframe load 后自动撤下

    // 仅在「关 → 开」跳变时做这些一次性动作，避免重复锁滚动 / 重复压栈。
    if (!isOpen) {
      isOpen = true
      // 压一条历史记录：让浏览器「后退」(含触控板两指左滑) 变成「关闭抽屉」，
      // 而不是把底层页面导航走。
      history.pushState({ bfloatDrawer: true }, '')
      lockScroll()
      document.addEventListener('keydown', onKeyDown, true)
      attachSwipe(window) // 顶层手势监听只在打开期间存在
      // 开启期间监听宿主页 bili_dark 变化，实时镜像到抽屉
      if (CONFIG.syncDrawerTheme && 'MutationObserver' in window) {
        drawerThemeDark = hostIsDark() // 记录基线，之后 bfloat-* 类变动不会被误判为主题切换
        themeObserver = new MutationObserver(applyDrawerTheme)
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      }
    }

    // 强制 reflow，确保从初始 transform 状态开始过渡动画
    void document.documentElement.offsetHeight
    document.documentElement.classList.add('bfloat-open')
  }

  // 用户主动关闭（按钮 / ESC / 点遮罩）：触发后退，由 popstate 统一收尾，保持历史干净
  function requestClose() {
    if (!isOpen) return
    history.back()
  }

  /* ---- 「新标签打开」= 把速看升级为完整观看 ---- */
  function getDrawerVideoEl() {
    try {
      return els?.iframe?.contentDocument?.querySelector('video') || null
    } catch (_) {
      return null // 跨域无法访问
    }
  }

  // 在原 URL 上带入当前播放进度(?t=秒)，让新标签无缝续播
  function buildNewTabUrl() {
    if (!CONFIG.newTabResumeTime) return currentUrl
    try {
      const u = new URL(currentUrl, location.href)
      const v = getDrawerVideoEl()
      const t = v && Number.isFinite(v.currentTime) ? Math.floor(v.currentTime) : 0
      if (t > 0) u.searchParams.set('t', String(t))
      return u.href
    } catch (_) {
      return currentUrl
    }
  }

  function onNewTab() {
    if (!currentUrl) return
    const url = buildNewTabUrl()
    // 先暂停抽屉内播放，避免与新标签的那一瞬双声
    try {
      getDrawerVideoEl()?.pause()
    } catch (_) {
      // ignore
    }
    // 保留 opener 关系：它是新标签「历史为 1 时左滑原生关闭、回到本页」的前提
    // （way-back 把历史钉在 1，关闭全靠 Safari 这个原生手势）。
    // 但 Safari 会在 open 的瞬间把本页 sessionStorage 克隆进新标签——
    // way-back 的回退栈被复制会凭空多出没走过的来时路，所以开之前临时摘掉、开完放回。
    const WAYBACK_KEY = 'bilikit-wayback-stack' // 与 way-back.user.js 的 STACK_KEY 同步
    let stash = null
    try {
      stash = sessionStorage.getItem(WAYBACK_KEY)
      if (stash != null) sessionStorage.removeItem(WAYBACK_KEY)
    } catch (_) {}
    window.open(url, '_blank')
    try {
      if (stash != null) sessionStorage.setItem(WAYBACK_KEY, stash)
    } catch (_) {}
    if (CONFIG.newTabClosesDrawer) requestClose()
  }

  // 实际收起 UI（由 popstate 调用：后退键 / 触控板左滑 / requestClose 间接触发）
  function closeUI() {
    if (!els) return
    // 立即暂停抽屉内播放：声音马上停，画面仍随面板照常滑出（iframe 在过渡结束后才销毁）。
    try {
      getDrawerVideoEl()?.pause()
    } catch (_) {
      // 跨域或已移除则忽略
    }
    isOpen = false
    document.documentElement.classList.remove('bfloat-open')
    document.removeEventListener('keydown', onKeyDown, true)
    detachSwipe(window)
    unlockScroll()
    setLoading(false) // 清掉可能残留的加载态
    // 重置滑动/拖拽状态，避免跨会话残留
    swipeAccum = 0
    dragging = false
    dragX = 0
    if (dragEndTimer) {
      clearTimeout(dragEndTimer)
      dragEndTimer = null
    }
    if (themeObserver) {
      themeObserver.disconnect()
      themeObserver = null
    }

    // 过渡结束后销毁 iframe：停止后台播放，并保证下次打开是全新的干净框架。
    // 延时略大于 CSS 过渡时长，二者共用 TRANSITION_MS。
    window.setTimeout(() => {
      if (els && !isOpen) {
        if (els.iframe) {
          els.iframe.remove()
          els.iframe = null
        }
        currentUrl = ''
        // 清掉跟手拖拽留下的内联样式，保证下次打开从干净的 class 状态开始（在动画结束后再清，避免打断滑出）
        els.panel.style.transform = ''
        els.panel.style.transition = ''
        els.backdrop.style.opacity = ''
        els.backdrop.style.transition = ''
      }
    }, TRANSITION_MS + 40)
  }

  function onPopState() {
    if (isOpen) closeUI()
  }
  window.addEventListener('popstate', onPopState)

  /* ---- 触控板横向滑动关闭 ---- */
  function onWheel(e) {
    if (!CONFIG.swipeToClose || !isOpen) return
    // 必须是明显的横向手势（横向位移远大于纵向），排除普通竖向滚动
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2) return

    if (!FOLLOW_DRAG) {
      // 非「右滑出」形态：保留「累计到阈值即关」的回退行为
      if (Math.sign(e.deltaX) === CONFIG.swipeBackDeltaXSign) {
        swipeAccum += Math.abs(e.deltaX)
        if (swipeResetTimer) clearTimeout(swipeResetTimer)
        swipeResetTimer = window.setTimeout(() => {
          swipeAccum = 0
        }, 150)
        if (swipeAccum >= CONFIG.swipeThreshold) {
          swipeAccum = 0
          requestClose()
        }
      } else {
        swipeAccum = 0
      }
      return
    }

    // 跟手拖拽：面板实时跟随手指横移；松手(DRAG_END_MS 无 wheel)后判定关闭 or 回弹。
    // dragX 随「返回方向」增大、反向减小，且不小于 0（拖不过打开位）。
    const stepBack = e.deltaX * CONFIG.swipeBackDeltaXSign // 本帧朝「返回方向」的位移
    // 事件间隔夹紧到 [4, 32]ms 再算速度：>32ms 视为新手势起步（按两帧估算，
    // 首帧速度不被长间隔稀释）；<4ms 防事件爆发时除出离谱值
    const dt = Math.min(32, Math.max(4, e.timeStamp - dragLastTs))
    dragLastTs = e.timeStamp
    dragX = Math.max(0, dragX + stepBack)
    if (!dragging) {
      // 死区内：面板不动、不计峰值，只安排空闲清零，微小滑动不留任何痕迹
      if (dragX < DRAG_START_PX) {
        if (dragEndTimer) clearTimeout(dragEndTimer)
        dragEndTimer = window.setTimeout(endDrag, DRAG_END_MS)
        return
      }
      dragging = true
      dragX = 0 // 越过死区才开始计量，死区距离不计入关闭判定
      dragPeakV = 0 // 新一次拖拽，重置甩动速度峰值
      dragPanelW = els.panel.offsetWidth || window.innerWidth // 拖拽期间宽度不变，缓存一次
      // 拖拽期间取消过渡，面板与背景都严格跟手（背景若保留 0.25s 过渡会滞后半拍）
      els.panel.style.transition = 'none'
      els.backdrop.style.transition = 'none'
    }
    const v = stepBack / dt
    if (v > dragPeakV) dragPeakV = v // 记录最快瞬间（甩动速度，px/ms）
    const w = dragPanelW
    const x = Math.min(dragX, w)
    els.panel.style.transform = `translateX(${x}px)`
    els.backdrop.style.opacity = String(Math.max(0, 1 - x / w))

    if (dragEndTimer) clearTimeout(dragEndTimer)
    dragEndTimer = window.setTimeout(endDrag, DRAG_END_MS)
  }

  // 拖拽「松手」：拖过约 25% 宽度、或快速甩动(仿 Safari 返回的速度判定)则顺势滑出关闭，否则回弹
  function endDrag() {
    dragEndTimer = null
    if (!els) return
    if (!dragging) {
      dragX = 0 // 死区内松手：清掉累计，下次滑动从零起算
      return
    }
    dragging = false
    const w = dragPanelW || els.panel.offsetWidth || window.innerWidth
    // 距离够 || 甩得够快（且不是甩完又拖回到接近起点 → 用 4% 宽度兜底，避免误关）
    const shouldClose = dragX > w * DRAG_CLOSE_RATIO || (dragPeakV >= DRAG_FLICK_VELOCITY && dragX > w * 0.04)
    // 恢复过渡，用于滑出/回弹动画
    els.panel.style.transition = ''
    els.backdrop.style.transition = ''
    dragX = 0
    if (shouldClose) {
      els.panel.style.transform = 'translateX(100%)' // 顺势滑出
      els.backdrop.style.opacity = '0'
      requestClose() // 走正常关闭收尾（历史/状态/销毁 iframe）
    } else {
      els.panel.style.transform = '' // 交还给 .bfloat-open 的 translateX(0)，回弹
      els.backdrop.style.opacity = ''
    }
  }

  // capture+passive 选项需在 add/remove 时一致才能正确解绑
  const WHEEL_OPTS = { passive: true, capture: true }
  function attachSwipe(win) {
    if (win) win.addEventListener('wheel', onWheel, WHEEL_OPTS)
  }
  function detachSwipe(win) {
    if (win) win.removeEventListener('wheel', onWheel, WHEEL_OPTS)
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return
    // 播放器全屏时，ESC 先交给浏览器退出全屏，不在此关抽屉
    if (isAnyFullscreen()) return
    e.preventDefault()
    e.stopPropagation()
    requestClose()
  }

  function isAnyFullscreen() {
    if (document.fullscreenElement) return true
    try {
      if (els?.iframe?.contentDocument?.fullscreenElement) return true
    } catch (_) {
      // 跨域无法访问，忽略
    }
    return false
  }

  function lockScroll() {
    prevHtmlOverflow = document.documentElement.style.overflow
    prevBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
  }

  function unlockScroll() {
    document.documentElement.style.overflow = prevHtmlOverflow
    document.body.style.overflow = prevBodyOverflow
  }

  /* ------------------------------------------------------------------ *
   * 点击拦截（捕获阶段，全局委托）
   * ------------------------------------------------------------------ */
  function isVideoLink(href) {
    return typeof href === 'string' && VIDEO_LINK_RE.test(href)
  }

  // 从被点击的链接就近找卡片封面图，作为加载占位
  function findCoverSrc(a) {
    const card = a.closest('.bili-video-card, .feed-card, .video-card, .bili-cover-card') || a
    const img = a.querySelector('img') || card.querySelector('img')
    return img?.currentSrc || img?.src || ''
  }

  function onClickCapture(e) {
    // 仅拦截纯左键单击；保留修饰键 / 中键 → 走浏览器默认（新标签等）
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return

    const target = e.target instanceof Element ? e.target : null
    const a = target?.closest('a[href]')
    if (!a) return
    if (!isVideoLink(a.href)) return

    e.preventDefault()
    e.stopPropagation()
    openDrawer(a.href, findCoverSrc(a))
  }

  document.addEventListener('click', onClickCapture, true)

  /* ---- 悬停预连接：每次悬停视频卡都按需预热连接（节流），让每个视频都开得快 ---- */
  const PRECONNECT_HOSTS = [
    'https://api.bilibili.com',
    'https://s1.hdslb.com',
    'https://i0.hdslb.com',
    'https://i1.hdslb.com',
    'https://i2.hdslb.com',
    'https://data.bilibili.com',
  ]
  const PRECONNECT_WINDOW = 12000 // ms：连接空闲约此量级会被浏览器回收，窗口内不重复预连接
  let lastPreconnectAt = 0
  let preconnectLinks = []

  function preconnectHosts() {
    const now = Date.now()
    if (now - lastPreconnectAt < PRECONNECT_WINDOW) return // 连接仍热，跳过
    lastPreconnectAt = now
    // 先移除上一批，避免 <head> 里 preconnect 节点累积（任意时刻最多一批）
    preconnectLinks.forEach((l) => l.remove())
    preconnectLinks = PRECONNECT_HOSTS.map((href) => {
      const link = document.createElement('link')
      link.rel = 'preconnect'
      link.href = href
      // 不设 crossOrigin：封面图(<img>)/脚本/样式都是 no-cors 请求，
      // 连接复用要求 preconnect 模式与真实请求一致，加 anonymous 反而全部失配弃用。
      document.head.appendChild(link)
      return link
    })
  }

  if (CONFIG.preconnectOnHover) {
    document.addEventListener(
      'mouseover',
      (e) => {
        // mouseover 是划过每个元素边界都触发的高频事件：先查节流窗口（一次时间戳比较），
        // 窗口内直接返回，不做 closest/正则
        if (Date.now() - lastPreconnectAt < PRECONNECT_WINDOW) return
        const t = e.target instanceof Element ? e.target : null
        const a = t?.closest('a[href]')
        if (a && isVideoLink(a.href)) preconnectHosts()
      },
      true,
    )
  }
})()
