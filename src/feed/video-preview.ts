import { NS } from './shared'
import { getDashPreview, getDurlSources } from './play-url'
import { attachMse } from './mse-preview'

/**
 * 封面 hover「真视频」预览：hover 一进就并行拉 dash 取流信息（藏在停留延迟里）；停留满 DELAY 后
 * 先试 **MSE**（原生级秒开 + 连续按需补拉、内存有界），失败/不支持则**回退 durl** `<video src>`。
 * 预览时封面遮罩(播放/弹幕数)淡出、右下角时长变「当前/总时长」；无进度条。
 * 再次 hover 同卡且仍健康 → 秒回放。**窗口化移除卡片前**由 feed.render() 调 cover.__bkTeardown 彻底拆除
 * （停 MSE 补拉、撤源、释放 objectURL），杜绝滚走后 zombie 补拉与内存泄漏。
 */
const DELAY = 500 // hover 停留判定：防鼠标划过就播（取流并行藏在这段等待里，到点即播、不牺牲速度）
const FADE = 220 // 与 CSS .bk-feed-vpreview 的 .2s 淡出对齐

// 并发预览实例数硬上限（窗口化之外的防御性兜底）：mouseleave 后 video/MSE 不会立刻拆，留着供再次 hover
// 秒回放——若同一窗口内短时间连续 hover 很多张卡（窗口可能同时挂着十几张卡，都没被滚动移出去），
// 各自留一份已解码首帧的实例会随 hover 次数无界累积。超过上限时，淘汰「最久未使用、且当前不在
// hover 中」的一个，彻底 teardown（同窗口化移除卡片时那份清理逻辑）。全 Feed 共享一份队列。
const MAX_ACTIVE = 3
const activeOrder: { teardown: () => void; isHovering: () => boolean }[] = []
function registerActive(entry: { teardown: () => void; isHovering: () => boolean }): void {
  const i = activeOrder.indexOf(entry)
  if (i !== -1) activeOrder.splice(i, 1) // 已在队列则先摘出，下面重新推到队尾（标记为最近使用）
  activeOrder.push(entry)
  while (activeOrder.length > MAX_ACTIVE) {
    const idx = activeOrder.findIndex((x) => !x.isHovering())
    if (idx === -1) break // 全部正被 hover（单鼠标场景几乎不可能）——本轮不淘汰，避免拆掉正在看的
    activeOrder.splice(idx, 1)[0].teardown()
  }
}
function unregisterActive(entry: { teardown: () => void; isHovering: () => boolean }): void {
  const i = activeOrder.indexOf(entry)
  if (i !== -1) activeOrder.splice(i, 1)
}

const fmt = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss < 10 ? '0' : ''}${ss}`
}

export function setupVideoPreview(cover: HTMLElement, bvid: string, cid?: string): void {
  let hovering = false
  let enterTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null // 淡出后再复位遮罩/时长
  let video: HTMLVideoElement | null = null
  let cands: string[] = []
  let ci = 0
  let t0 = 0
  let mode = '' // 'mse' | 'durl'
  let attemptOk = false // 上次尝试已成功起播且仍健康（用于再次 hover 秒回放的门槛）
  const durEl = cover.querySelector(`.${NS}-mask > span`) as HTMLElement | null // 右下角时长位
  const origDur = durEl ? durEl.textContent || '' : '' // 原始时长文本，走后还原

  const ensureEls = (): void => {
    if (video) return
    // 封面的 isolation:isolate 已在 CSS 常驻（修 #77572 圆角裁不住 <video>）——不再按需增删 .hasvp：
    // 动态开关 isolation 会 churn 合成层、顶得邻卡遮罩位移露缝（见 styles.ts 注释）。
    video = document.createElement('video')
    video.className = `${NS}-vpreview`
    video.muted = true
    video.loop = true
    video.preload = 'auto'
    video.setAttribute('playsinline', '')
    // 时长位实时「当前 / 总时长」——仅在预览显示时写，避免 stop() 后残留的 timeupdate 把还原的文本又覆盖
    video.addEventListener('timeupdate', () => {
      if (video && video.duration && isFinite(video.duration) && cover.classList.contains('previewing')) {
        if (durEl) durEl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`
      }
    })
    video.addEventListener('error', () => {
      if (mode === 'durl' && ci + 1 < cands.length) { console.warn(`[BiliKit-Web Feed] durl 源#${ci} 失败，换下一个`); playDurl(ci + 1) }
      else if (mode === 'durl') attemptOk = false // durl 候选全失败 → 别再走秒回放
    })
    cover.appendChild(video)
  }

  const playDurl = (i: number): void => {
    if (!video || i >= cands.length) return
    ci = i; mode = 'durl'
    video.src = cands[i]; video.load()
    video.play().catch(() => { /* ignore */ })
  }

  const restoreCover = (): void => {
    cover.classList.remove('previewing') // 恢复遮罩/播放数
    if (durEl) durEl.textContent = origDur // 还原原始时长
  }

  const show = (): void => {
    if (!video) return
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null } // 取消待复位（再次 hover 回来）
    attemptOk = true
    cover.classList.add('previewing') // 隐遮罩/播放数、时长转「当前/总时长」
    video.classList.add('on')
    registerActive(selfEntry) // 挂进全局并发上限队列，超额时会淘汰最久未用的（见文件顶部）
  }

  // mouseleave：淡出预览，但**保留** video/MSE 供再次 hover 秒回放（补拉随 timeupdate 停止而自然暂停）。
  // 平滑退出：先移 .on 触发视频 .2s 淡出（淡出中视频继续播），淡完再恢复遮罩/时长——否则遮罩瞬间弹回盖住淡出中的视频，像没动画。
  const stop = (): void => {
    hovering = false
    if (enterTimer) { clearTimeout(enterTimer); enterTimer = null }
    // video 已创建但尚未 show() = 正在等 dash/MSE 起播。此时只复位 UI 会留下一个未登记进
    // activeOrder 的隐藏 MSE 实例；必须直接拆流。attachMse 的外部 dispose 会 resolve(false)，
    // 因而下方 await 也能正常结束，不会再悬着闭包。
    if (!video || !video.classList.contains('on')) {
      if (video) teardown()
      else restoreCover()
      return
    }
    video.classList.remove('on') // 触发淡出
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (hovering) return // 期间又 hover 回来 → 不复位
      restoreCover()
      try { video?.pause() } catch { /* ignore */ }
    }, FADE)
  }

  // 卡片被窗口化移除前调用：立即（不淡出）彻底拆除 MSE（停补拉、撤源、释放 objectURL）+ 移除 video 元素
  // 并发上限淘汰命中时也会调用这个（见 registerActive）——两条路径共用同一份拆除逻辑。
  const teardown = (): void => {
    hovering = false
    if (enterTimer) { clearTimeout(enterTimer); enterTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    restoreCover()
    attemptOk = false
    unregisterActive(selfEntry)
    if (video) {
      try { (video as any).__mseCleanup?.() } catch { /* ignore */ }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
      try { video.remove() } catch { /* ignore */ }
      video = null
    }
  }
  const selfEntry = { teardown, isHovering: () => hovering }
  ;(cover as any).__bkTeardown = teardown

  cover.addEventListener('mouseenter', () => {
    if (hovering) return
    hovering = true
    // 已装载且仍健康 → 秒回放，不再拉流
    if (attemptOk && video && video.readyState >= 2 && !video.error) { video.play().catch(() => { /* ignore */ }); show(); return }
    t0 = performance.now()
    const dashP = getDashPreview(bvid, cid) // 立刻并行开拉，藏在停留延迟里
    enterTimer = setTimeout(async () => {
      enterTimer = null
      if (!hovering || !cover.isConnected) return
      ensureEls()
      const dash = await dashP
      if (!hovering || !cover.isConnected) { stop(); return }
      // 1) 首选 MSE
      let ok = false
      if (dash && video) {
        mode = 'mse'
        ok = await attachMse(video, dash)
        if (!hovering || !cover.isConnected) { teardown(); return }
        if (ok) console.debug(`[BiliKit-Web Feed] MSE 起播 ${(performance.now() - t0) | 0}ms ${bvid}`)
      }
      // 2) 回退 durl <video src>
      if (!ok) {
        const srcs = await getDurlSources(bvid, cid)
        if (!srcs || !srcs.length || !hovering || !cover.isConnected) { stop(); return }
        cands = srcs
        playDurl(0)
      }
      if (!hovering || !cover.isConnected) { stop(); return } // 拉流期间已移开/移除 → 别再显示
      show()
    }, DELAY)
  })
  cover.addEventListener('mouseleave', stop)
}
