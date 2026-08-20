import { register, runAll } from './core/module'
import { syncSharedSettings } from './core/settings'
import { mountPanel } from './core/panel'
import { cdnPick } from './modules/cdn-pick'
import { themeSync } from './modules/theme-sync'
import { commentLocation } from './modules/comment-location'
import { wakeLock } from './modules/wake-lock'
import { noLogin } from './modules/no-login'
import { wayBack } from './modules/way-back'
import { installSiteDrawer } from './modules/site-drawer'
import {
  DRAWER_DOCUMENT_NAV_KEY,
  DRAWER_MARK,
  DRAWER_WEB_MARK,
  drawerFrameName,
  drawerMark,
  readDrawerFrameName,
  safeDrawerVideoUrl,
  shouldReplaceDrawerDocument,
} from './core/drawer-history'
import { consumeHistoryFlattenTarget } from './core/new-tab'
import { shouldFlattenVideoNavigation } from './modules/way-back/core'

// iframe 的 window.name 跨同一 browsing context 的整页导航保留；比只靠 URL hash 稳定。
// 新文档若被 B 站整页导航/重定向时丢了 marker，document-start 立即用 replaceState 补回，
// 这样下方各 Core 模块（包括仍按 hash 判断的 way-back）仍会把它认作同一个抽屉。
const drawerFrame = window.top !== window.self ? readDrawerFrameName(window.name) : null
if (drawerFrame && !drawerMark(location.hash)) {
  try {
    const url = new URL(location.href)
    url.hash = drawerFrame.webFull ? DRAWER_WEB_MARK : DRAWER_MARK
    History.prototype.replaceState.call(history, history.state, '', url.href)
  } catch { /* ignore */ }
}
const inDrawer = window.top !== window.self && (!!drawerFrame || !!drawerMark(location.hash))
const drawerToken = drawerFrame?.token || ''
const drawerWebFull = drawerFrame?.webFull ?? (location.hash === DRAWER_WEB_MARK)

// Safari 新标签实验：只有 openBiliKitVideoTab 留下的一次性 window.name 标记能进入这里。
// 提升到 Core 启动层而不依赖可关闭的“回程”模块；回程稍后再包一层只负责记录来时路。
// 不拦截 click、不处理分 P/整页导航，避免旧实现的双重加载与过度改写。
function setupMarkedNewTabHistoryFlatten(): void {
  if (!consumeHistoryFlattenTarget()) return
  const originalPush = history.pushState.bind(history)
  const originalReplace = history.replaceState.bind(history)
  history.pushState = function (this: History, ...args: Parameters<History['pushState']>): void {
    const target = args[2]
    if (target != null && shouldFlattenVideoNavigation(location.href, String(target))) {
      originalReplace(...args)
      return
    }
    originalPush(...args)
  }
}
setupMarkedNewTabHistoryFlatten()

function postDrawer(type: string, extra: Record<string, unknown> = {}): void {
  if (!drawerToken) return
  try { window.parent.postMessage({ type, token: drawerToken, ...extra }, '*') } catch { /* ignore */ }
}

// 抽屉内部点相关视频时，History bridge 会在整页 replace 前同步停住旧播放器。
// 用回调解耦安装顺序，实际点击发生在 media lifecycle 完成安装之后。
let suspendDrawerMedia = (_preserveResume = true): void => {}

// 跨子域对齐设置：把 .bilibili.com cookie 里的共享设置并回本域 localStorage（www/search/space 用同一份），
// 老用户则反向种一次 cookie。必须在任何模块读设置（runAll）之前。
syncSharedSettings()

// 心跳：与 Feed 同源共享 localStorage，写入本次运行时间戳，供 Feed 判断 Core 是否已安装并在跑。
try { localStorage.setItem('bilikit:alive.core', String(Date.now())) } catch { /* 隐私模式忽略 */ }

// 在 BiliKit-Web 抽屉的 iframe 内（父页给 URL 打了 #bk-drawer 标记）隐藏站内顶栏 + 广告位，让播放器占满。
// 只在「子框架 + 标记」时生效；Core @run-at document-start，注入的样式先于渲染就位，不闪。
// 广告选择器沿用原 float 脚本的清单。
function hideDrawerChrome(): void {
  if (!inDrawer) return
  const ads = ['.ad-report', '.video-page-special-card-small', '.video-page-game-card-small', '.slide-ad-exp', '.activity-m-v1', '.pop-live-small-mode', '.right-bottom-banner', '.eva-banner', '.gg-floor-module', '.video-card-ad-small']
  const s = document.createElement('style')
  s.textContent =
    `#biliMainHeader,.bili-header,.fixed-header,.international-header{display:none!important}` +
    ads.join(',') + `{display:none!important}`
  ;(document.head || document.documentElement).appendChild(s)
}
hideDrawerChrome()

// 抽屉 iframe 获得焦点后，键盘事件不会冒泡到父文档。仿 BewlyCat：在子窗口捕获 Esc，
// 用 postMessage 请求父页关闭；父页还会核对 event.source===当前 iframe，外部页面无法伪造。
// 编辑器内的 Esc 留给输入法/输入框，浏览器真全屏也先让 Safari 自己退出。
function setupDrawerEscape(): void {
  if (!inDrawer) return
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'Escape' && e.code !== 'Escape') || e.isComposing) return
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) return
    const editing = e.composedPath().some((n) => n instanceof HTMLElement && (
      n.isContentEditable || n.matches('input,textarea,select')
    ))
    if (editing) return
    e.preventDefault()
    e.stopPropagation()
    postDrawer('bk-drawer-close')
  }, true)
}
setupDrawerEscape()

// 把抽屉子页真实地址发给父页，让顶层地址栏与当前播放内容保持一致。
// 更重要的是：不同视频绝不留在 B 站 SPA 内切换。拦到 pushState 后先暂停，再 location.replace 创建新 Document；
// 同一内容的无关 query 仍压成 replaceState；不同视频、剧集和分 P 都换 Document，避免污染联合历史并释放旧 SPA。
function setupDrawerLocationSync(): void {
  if (!inDrawer) return
  let lastUrl = ''
  let leavingDocument = false
  let leavingPublicUrl = ''
  let leavingToken = ''
  let observedDocumentUrl = location.href
  const mark = drawerWebFull ? DRAWER_WEB_MARK : DRAWER_MARK
  const notify = (): void => {
    const url = new URL(location.href)
    if (drawerMark(url.hash)) url.hash = ''
    const href = url.href
    if (href === lastUrl) return
    lastUrl = href
    postDrawer('bk-drawer-location', { url: href })
  }
  const originalReplace = history.replaceState.bind(history)
  const markedUrl = (raw: string | URL | null | undefined): string | URL | null | undefined => {
    if (raw == null) return raw
    try {
      const url = new URL(String(raw), location.href)
      if (url.origin === location.origin) url.hash = mark
      return url.href
    } catch { return raw }
  }
  const newDocumentToken = (): string => {
    try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
  }
  const replaceDocument = (raw: string | URL, preserveWayBack: boolean, token = newDocumentToken(), webFull = drawerWebFull): void => {
    if (leavingDocument) {
      // 父页换片命令与本页已开始的站内 hard replace 并发时，已在途的导航不可撤销。
      // 重报实际目标/nonce，让父页先接管它，再排队父页的最新目标；不能静默丢命令。
      if (!preserveWayBack && leavingPublicUrl && leavingToken) {
        postDrawer('bk-drawer-navigating', { url: leavingPublicUrl, nextToken: leavingToken })
      }
      return
    }
    let expectedOrigin = location.origin
    if (!preserveWayBack) {
      try { expectedOrigin = new URL(String(raw), location.href).origin } catch { /* 下方统一拒绝 */ }
    }
    const publicUrl = safeDrawerVideoUrl(String(raw), expectedOrigin)
    if (!publicUrl || !/^[0-9a-z-]{8,}$/i.test(token)) {
      if (!preserveWayBack) postDrawer('bk-drawer-replace-failed', { nextToken: token })
      return
    }
    const target = new URL(publicUrl)
    target.hash = webFull ? DRAWER_WEB_MARK : DRAWER_MARK
    leavingDocument = true
    leavingPublicUrl = publicUrl
    leavingToken = token
    if (preserveWayBack) {
      try { sessionStorage.setItem(DRAWER_DOCUMENT_NAV_KEY, publicUrl) } catch { /* ignore */ }
    }
    suspendDrawerMedia(false)
    window.name = drawerFrameName({ token, webFull })
    try {
      location.replace(target.href)
      if (preserveWayBack) postDrawer('bk-drawer-navigating', { url: publicUrl, nextToken: token })
      // 父页发起的换页在 location.replace 已被浏览器接受后才确认；
      // 父页由此切换到 nextToken，之后旧 Document 的迟到消息会被拒绝。
      if (!preserveWayBack) postDrawer('bk-drawer-replacing', { url: publicUrl, nextToken: token })
    } catch {
      leavingDocument = false
      leavingPublicUrl = ''
      leavingToken = ''
      if (drawerToken) window.name = drawerFrameName({ token: drawerToken, webFull: drawerWebFull })
      if (preserveWayBack) { try { sessionStorage.removeItem(DRAWER_DOCUMENT_NAV_KEY) } catch { /* ignore */ } }
      else postDrawer('bk-drawer-replace-failed', { nextToken: token })
    }
  }

  // 点击阶段先于 Vue Router 截住相关视频，避免等到 pushState 时新组件/请求已经开始创建。
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = e.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement && !!node.href)
    if (!anchor || anchor.download || (anchor.target && anchor.target !== '_self')) return
    const target = markedUrl(anchor.href)
    if (target == null || !shouldReplaceDrawerDocument(location.href, String(target))) return
    e.preventDefault()
    e.stopImmediatePropagation()
    replaceDocument(String(target), true)
  }, true)
  // 抽屉自己的“回程”栈已经记录视频来路，因此 iframe 的原生 SPA 历史应压成 replace：
  // 避免嵌套 browsing context 的 joint session history 抢在顶层 drawer entry 前面，确保 Back 一次关抽屉。
  history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
    const next = markedUrl(url)
    if (next != null && shouldReplaceDrawerDocument(location.href, String(next))) {
      replaceDocument(String(next), true)
      return
    }
    const result = originalReplace(state, unused, next)
    queueMicrotask(notify)
    return result
  }) as typeof history.pushState
  history.replaceState = ((state: unknown, unused: string, url?: string | URL | null) => {
    const next = markedUrl(url)
    if (next != null && shouldReplaceDrawerDocument(location.href, String(next), true)) {
      replaceDocument(String(next), true)
      return
    }
    const result = originalReplace(state, unused, next)
    queueMicrotask(notify)
    return result
  }) as typeof history.replaceState
  window.addEventListener('popstate', notify)
  window.addEventListener('hashchange', notify)
  // 若站点保存了原生 History 引用、重包实例方法或直接调用 prototype，URL 已变后仍补一次整页 replace。
  setInterval(() => {
    if (!leavingDocument && shouldReplaceDrawerDocument(observedDocumentUrl, location.href, true)) {
      replaceDocument(location.href, true)
      return
    }
    // ss -> ep 规范化或同内容 query 已安全落地；以它为新基线，
    // 否则之后真正的 ep1 -> ep2 会被一直误判为“从 ss 规范化”。
    observedDocumentUrl = location.href
    notify()
  }, 500)
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.data?.token !== drawerToken || e.data?.type !== 'bk-drawer-replace') return
    if (typeof e.data.url !== 'string' || typeof e.data.nextToken !== 'string' || typeof e.data.webFull !== 'boolean') return
    replaceDocument(e.data.url, false, e.data.nextToken, e.data.webFull)
  })
  notify()
}

// 抽屉内（父页打 #bk-drawer / #bk-drawer-web）：单个轮询循环同时干两件揭幕相关的事，跑完即停：
//   ① 首帧就绪 → postMessage('bk-drawer-ready')：Feed 据此撤加载遮罩。以 readyState≥2(HAVE_CURRENT_DATA)
//      或 loadeddata/canplay 为准——比等真正开播(currentTime>0)更早，抢在出声前揭幕、声音不先于画面。
//   ② 仅 -web 模式：点一次原生「网页全屏」按钮让播放器铺满抽屉，铺满(data-screen=web)后 postMessage('bk-drawer-webfull')。
//      网页全屏是纯页面布局(非 OS 全屏)，无需用户手势。**只点一次**：点了不停手，靠后续 tick 确认 data-screen=web，
//      绝不再点——否则再点一次会把网页全屏切回去、来回横跳。
// 合成一个 interval（而非两个并发）省掉重复 querySelector；ready 与 web 都完成或超时即 clearInterval，不留常驻定时器。
function setupDrawerReveal(): void {
  if (!inDrawer) return
  const wantWeb = drawerWebFull
  // targetOrigin 用 '*'：抽屉从 search/space 等子域打开时，父页 origin 与本 iframe(www) 不同，
  // 用 location.origin 会导致信号被浏览器丢弃 → 父页收不到、只能等 6s 兜底（揭幕很晚）。信号非敏感，'*' 即可。
  let readyDone = false
  let webDone = !wantWeb // 普通抽屉无需铺满，直接算完成
  let bound = false
  let clicked = false
  let tries = 0
  let lateReadyTimer: ReturnType<typeof setInterval> | null = null
  // 焦点落到播放器：父页已把键盘路由进本 iframe（contentWindow.focus），这里再把焦点具体放到播放器容器，
  // 否则焦点在 <body> 上、空格会滚动视频页而非暂停。容器无 tabindex 则临时补 -1 使其可聚焦；preventScroll 防聚焦滚动。
  const focusPlayer = (): void => {
    try {
      const box = document.querySelector('.bpx-player-container') as HTMLElement | null
      if (box) { if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1'); box.focus({ preventScroll: true }) }
      else (document.querySelector('video') as HTMLElement | null)?.focus({ preventScroll: true })
    } catch { /* 忽略 */ }
  }
  const onReady = (): void => {
    if (readyDone) return
    readyDone = true
    if (lateReadyTimer) { clearInterval(lateReadyTimer); lateReadyTimer = null }
    postDrawer('bk-drawer-ready')
    focusPlayer()
    // 父页收到 ready 后会 focus() iframe 元素使本 frame 成为活动帧；那一下可能把内部焦点复位到 <body>，
    // 且播放器容器偶尔略晚挂载——故再补两次，确保焦点稳稳落在播放器上（跨源从 search/space 打开时尤其需要）。
    setTimeout(focusPlayer, 150)
    setTimeout(focusPlayer, 400)
  }
  const timer = setInterval(() => {
    if (!readyDone) {
      const v = document.querySelector('video') as HTMLVideoElement | null
      if (v) {
        if (v.readyState >= 2) onReady() // 首帧已就绪 → 立刻揭幕
        else if (!bound) { bound = true; v.addEventListener('loadeddata', onReady, { once: true }); v.addEventListener('canplay', onReady, { once: true }) } // 首帧一解出即揭，比轮询更即时
      }
    }
    if (!webDone) {
      if (document.querySelector('.bpx-player-container[data-screen="web"]')) { webDone = true; postDrawer('bk-drawer-webfull') } // 已铺满
      else if (!clicked) { const btn = document.querySelector('.bpx-player-ctrl-web') as HTMLElement | null; if (btn) { btn.click(); clicked = true } } // 只点一次
    }
    if (readyDone && webDone) clearInterval(timer)
    else if (++tries > 60) {
      clearInterval(timer)
      postDrawer('bk-drawer-reveal-timeout')
      // 极慢网络下 9s 时可能连 <video> 都没创建；改成低频有界等待，首帧迟到仍会解开初始媒体闸门。
      if (!readyDone) {
        let lateTries = 0
        lateReadyTimer = setInterval(() => {
          const video = document.querySelector('video') as HTMLVideoElement | null
          if (video?.readyState && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onReady()
          if (++lateTries > 120 && lateReadyTimer) { clearInterval(lateReadyTimer); lateReadyTimer = null }
        }, 500)
      }
    }
  }, 150)
}
setupDrawerReveal()

// 单 iframe 常驻：关闭抽屉只暂停当前正在播放的媒体，不清 src/MSE、不销毁文档；复开同一会话时只恢复
// 关闭前确实在播放的媒体。若慢导航在关闭后才触发 autoplay，capture play 会立即按回暂停并记入待恢复集合。
// 真正换视频（同一 iframe 导航）或顶层离开时，pagehide/unload 才做破坏性清理，帮助旧文档尽快断解码资源。
function setupDrawerMediaLifecycle(): void {
  if (!inDrawer) return
  let parked = false
  let cleaned = false
  let pauseWatchdog: ReturnType<typeof setInterval> | null = null
  const resumeSet = new Set<HTMLMediaElement>()
  const mediaElements = (): HTMLMediaElement[] => {
    const found = [...document.querySelectorAll<HTMLMediaElement>('video,audio')]
    // B 站主播放器在顶层文档；只额外探测同源子框架，不遍历全 DOM 找 shadowRoot，控制暂停路径开销。
    document.querySelectorAll<HTMLIFrameElement>('iframe').forEach((child) => {
      try { if (child.contentDocument) found.push(...child.contentDocument.querySelectorAll<HTMLMediaElement>('video,audio')) } catch { /* cross-origin */ }
    })
    return found
  }
  const pauseNow = (preserveResume: boolean): void => {
    const media = mediaElements()
    if (preserveResume) {
      media.forEach((item) => { if (!item.paused && !item.ended) resumeSet.add(item) })
    }
    try {
      const player = (window as unknown as { player?: { pause?: () => void } }).player
      player?.pause?.()
    } catch { /* B 站未暴露 player 或播放器正在重建 */ }
    media.forEach((item) => {
      try { item.pause() } catch { /* ignore */ }
    })
  }
  const stopPauseWatchdog = (): void => {
    if (pauseWatchdog) { clearInterval(pauseWatchdog); pauseWatchdog = null }
  }
  const suspend = (preserveResume = true): void => {
    parked = true
    if (!preserveResume) resumeSet.clear()
    pauseNow(preserveResume)
    stopPauseWatchdog()
    let left = 12
    // 覆盖“关闭/换路由后播放器才异步 autoplay”的窗口；3s 后自动停，不留常驻轮询。
    pauseWatchdog = setInterval(() => {
      pauseNow(preserveResume)
      if (--left <= 0) stopPauseWatchdog()
    }, 250)
    postDrawer('bk-drawer-suspended')
  }
  const resume = (): void => {
    stopPauseWatchdog()
    parked = false
    const pending = [...resumeSet]
    resumeSet.clear()
    for (const media of pending) {
      if (!media.isConnected || media.ended) continue
      try { void media.play().catch(() => { /* 自动播放策略拦截则保持暂停 */ }) } catch { /* ignore */ }
    }
  }
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    stopPauseWatchdog()
    resumeSet.clear()
    try {
      mediaElements().forEach((media) => {
        media.pause()
        media.removeAttribute('src') // 走 <video src=blobUrl>（MSE 老 API）这条
        ;(media as any).srcObject = null // 走 video.srcObject=MediaSource（ManagedMediaSource）这条
        media.load() // 重置媒体元素、断开当前 MediaSource，尽早吐出旧文档解码资源
      })
    } catch { /* 尽力而为，不影响文档导航/卸载 */ }
  }
  document.addEventListener('play', (e) => {
    if (!parked || !(e.target instanceof HTMLMediaElement)) return
    resumeSet.add(e.target)
    try { e.target.pause() } catch { /* ignore */ }
  }, true)
  window.addEventListener('pagehide', cleanup)
  window.addEventListener('unload', cleanup)
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.data?.token !== drawerToken) return
    if (e.data.type === 'bk-drawer-suspend') suspend()
    else if (e.data.type === 'bk-drawer-resume') resume()
  })
  suspendDrawerMedia = suspend
}
setupDrawerMediaLifecycle()
setupDrawerLocationSync()
// 等 replace/location 两类消息监听器都安装完再发首次暂停确认，避免父页立即回发 replace 时子页尚未能接收。
suspendDrawerMedia(false)

// 注册所有 Core（页面世界，@grant none）模块。
// cdn-pick / theme-sync 先跑（runAt='start'，需在页面用 fetch / 首帧换肤前挂钩）。
// 暂缓：float / way-back（与将来的 App 推荐 feed 有交互冲突，待 feed 定后再迁）；
//       quality-watch / home-clean（尚未上线）。
register(
  cdnPick,
  themeSync,
  commentLocation,
  wakeLock,
  noLogin, // 注册在 cdn-pick 之后：其 fetch/XHR 与 __playinfo__ hook 需叠在最外层（改请求；cdn-pick 改响应 host）
  wayBack, // 视频页回退栈胶囊（顶层 + 抽屉 iframe）
)

runAll()

// 全站抽屉：无独立开关，由「打开方式」驱动（当前页=不拦）。委托点击拦截，自守卫顶层窗口 + 幂等。
installSiteDrawer()

// 左下悬浮齿轮 + 设置面板（仅顶层窗口）
mountPanel()
