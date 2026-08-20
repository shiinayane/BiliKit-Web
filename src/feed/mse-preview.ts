import { gmRequestBinary } from './app-api'
import type { DashPreview } from './play-url'

/**
 * 用 MSE 秒开 + 连续播放封面预览：抓 init + sidx，解析每个 fragment 的字节边界，起播只喂头几个 fragment，
 * 之后随播放**按需补拉**，直到拉满 MAX_MEDIA_BYTES（或整段拉完）才 endOfStream（loop 复播已缓冲部分）。
 * 见 docs/RESEARCH-mse-preview.md。
 *  - 取字节优先浏览器 fetch（与原生同法，冷门视频 CDN 也回 206；bilivideo 对本源放行 CORS），GM 兜底。
 *  - 通用：ManagedMediaSource(Safari17+/iOS) || MediaSource(桌面三家)，同一套代码。
 *  - 内存有界：总字节封顶（MAX_MEDIA_BYTES），头部始终保留 → loop 无需重取；卡片被窗口化移除时经
 *    video.__mseCleanup 完整拆除（停补拉、摘监听、撤源、释放 objectURL）。
 */
const PLAY_WATCH = 1600 // append 后没起播的看门狗
const OPEN_GUARD = 3000 // sourceopen 迟迟不来的兜底
const HIGH_WATER = 15 // 缓冲够这么多秒就暂停补拉
const LOW_WATER = 8 // 缓冲低于这么多秒就补拉
const BATCH_BYTES = 500_000 // 每次补拉目标字节（取整数个 fragment）
const MAX_MEDIA_BYTES = 8_000_000 // 单卡预览总字节上限（~360p 3-4 分钟）：够长、又把每卡内存钉在 ~8MB

const MS_CTOR = (): any => (window as any).ManagedMediaSource || (window as any).MediaSource || null
const isMMS = (): boolean => !!(window as any).ManagedMediaSource

// 逐候选主机抓一段字节（Range 含端点）。优先浏览器 fetch（原生同法：CDN 认、冷门也 206；CORS 对本源放行）；
// fetch 被 CORS/CSP 挡才退回 GM（GM 会被 CDN 反爬 403 掉冷门视频，只作兜底）。全失败才抛。
async function fetchRange(urls: string[], start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const range = `bytes=${start}-${end}`
  let last: unknown
  for (const u of urls) {
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    try {
      const r = await fetch(u, { headers: { Range: range }, credentials: 'omit', cache: 'no-store', signal })
      if (r.status === 206) return await r.arrayBuffer()
      last = new Error('fetch HTTP ' + r.status)
    } catch (e) { if (signal.aborted) throw e; last = e }
  }
  for (const u of urls) {
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    try { return await gmRequestBinary(u, { start, end }, signal) } catch (e) { if (signal.aborted) throw e; last = e }
  }
  throw last || new Error('all urls failed')
}

// 解析 sidx → 每个 fragment 的字节大小（顺序）。边界安全，失败返回 null（调用方退回单窗）。
function parseSidx(sidxBuf: ArrayBuffer): number[] | null {
  try {
    const dv = new DataView(sidxBuf); const N = dv.byteLength
    const u8 = (p: number) => (p + 1 <= N ? dv.getUint8(p) : 0)
    const u16 = (p: number) => (p + 2 <= N ? dv.getUint16(p) : 0)
    const u32 = (p: number) => (p + 4 <= N ? dv.getUint32(p) : 0)
    const typeAt = (p: number) => String.fromCharCode(u8(p + 4), u8(p + 5), u8(p + 6), u8(p + 7))
    let pos = 0
    if (typeAt(0) !== 'sidx') {
      let p = 0, g = 0
      while (p + 8 <= N && g++ < 32) { if (typeAt(p) === 'sidx') break; const s = u32(p); if (s <= 0) return null; p += s }
      if (p + 8 > N || typeAt(p) !== 'sidx') return null
      pos = p
    }
    const version = u8(pos + 8)
    let p = pos + 12 + 4 // version/flags(4) + reference_ID(4)
    p += 4 // timescale（字节批不需要秒，略过）
    p += version === 0 ? 8 : 16 // EPT + first_offset
    p += 2 // reserved
    const refCount = u16(p); p += 2
    const sizes: number[] = []
    for (let i = 0; i < refCount && p + 12 <= N; i++) { sizes.push(u32(p) & 0x7fffffff); p += 12 } // size(4)+dur(4)+sap(4)
    return sizes.length ? sizes : null
  } catch { return null }
}

function appendWait(sb: any, buf: ArrayBuffer, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const clean = () => {
      sb.removeEventListener('updateend', ok)
      sb.removeEventListener('error', er)
      signal.removeEventListener('abort', onAbort)
    }
    const ok = () => { clean(); res() }
    const er = () => { clean(); rej(new Error('append error')) }
    const onAbort = () => {
      clean()
      try { if (sb.updating) sb.abort() } catch { /* ignore */ }
      rej(signal.reason || new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) { onAbort(); return }
    sb.addEventListener('updateend', ok)
    sb.addEventListener('error', er)
    signal.addEventListener('abort', onAbort, { once: true })
    try { sb.appendBuffer(buf) } catch (e) { clean(); rej(e) }
  })
}

/**
 * 给 <video> 挂 MSE 播放 dash 预览（连续、内存有界）。resolve(true)=已起播；resolve(false)=不支持/失败/超时（回退 durl）。
 * 起播后内部持续按需补拉（封顶 MAX_MEDIA_BYTES）。挂 video.__mseCleanup：卡片被移除时调用它彻底拆除。
 */
export function attachMse(video: HTMLVideoElement, dash: DashPreview): Promise<boolean> {
  const MS = MS_CTOR()
  if (!MS) { console.debug('[BiliKit-Web Feed] MSE 不可用：无 MediaSource'); return Promise.resolve(false) }
  return new Promise<boolean>((resolve) => {
    let settled = false, dead = false, objUrl = ''
    let ms: any = null, sb: any = null
    const aborter = new AbortController()
    let openGuard: ReturnType<typeof setTimeout> | null = setTimeout(() => finish(false), OPEN_GUARD)
    let playWatch: ReturnType<typeof setTimeout> | null = null
    const pumpListeners: Array<[string, EventListener]> = []

    const onPlaying = () => finish(true)
    const onVidErr = () => console.debug('[BiliKit-Web Feed] MSE video error code=', video.error && video.error.code)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onVidErr, { once: true })

    const safeEnd = () => { try { if (ms && ms.readyState === 'open' && sb && !sb.updating) ms.endOfStream() } catch { /* ignore */ } }

    // 完整拆除：停补拉、摘所有监听、暂停、撤源、释放 objectURL。窗口化移除卡片时由外部经 video.__mseCleanup 调用；失败时内部调用。
    function dispose(): void {
      const resolvePending = !settled
      if (resolvePending) settled = true
      dead = true
      aborter.abort()
      if (openGuard) { clearTimeout(openGuard); openGuard = null }
      if (playWatch) { clearTimeout(playWatch); playWatch = null }
      for (const [ev, h] of pumpListeners) video.removeEventListener(ev, h)
      pumpListeners.length = 0
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', onVidErr)
      try { video.pause() } catch { /* ignore */ }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
      try { if (objUrl) URL.revokeObjectURL(objUrl) } catch { /* ignore */ }
      objUrl = ''
      // 外部 teardown 可能发生在 attachMse 尚未起播、调用方仍 await 的阶段；清理后必须结算 Promise。
      if (resolvePending) resolve(false)
    }
    ;(video as any).__mseCleanup = dispose

    function finish(ok: boolean): void {
      if (settled) return
      settled = true
      if (openGuard) { clearTimeout(openGuard); openGuard = null }
      if (playWatch) { clearTimeout(playWatch); playWatch = null }
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', onVidErr)
      if (!ok) dispose() // 失败：彻底拆除，交回调用方回退 durl（成功则保留，补拉继续）
      resolve(ok)
    }

    try {
      if (isMMS()) (video as any).disableRemotePlayback = true
      ms = new MS()
      objUrl = URL.createObjectURL(ms)
      video.src = objUrl
      ms.addEventListener('error', () => finish(false))
      ms.addEventListener('sourceopen', async () => {
        if (openGuard) { clearTimeout(openGuard); openGuard = null }
        try {
          const header = await fetchRange(dash.urls, 0, dash.indexEnd, aborter.signal) // init + sidx 一把取
          if (dead) return
          const sizes = parseSidx(header.slice(dash.indexStart, dash.indexEnd + 1))
          sb = ms.addSourceBuffer(`video/mp4; codecs="${dash.codecs}"`)
          await appendWait(sb, header.slice(0, dash.initEnd + 1), aborter.signal) // init 段
          if (dead) return
          const mediaBase = dash.indexEnd + 1

          if (!sizes) {
            // 兜底：sidx 解析不出 → 抓固定单窗，endOfStream + loop
            const media = await fetchRange(dash.urls, mediaBase, mediaBase + 600_000, aborter.signal)
            if (dead) return
            await appendWait(sb, media, aborter.signal)
            safeEnd()
          } else {
            // 连续：按 fragment 顺序补拉，缓冲低就补、够了就停，拉满上限或整段拉完 endOfStream
            const offsets = [0]
            for (let i = 0; i < sizes.length; i++) offsets.push(offsets[i] + sizes[i])
            let fi = 0, ended = false, pumping = false, fetched = 0
            const ahead = () => { try { const b = video.buffered; return b.length ? b.end(b.length - 1) - video.currentTime : 0 } catch { return 0 } }
            const doneAll = () => fi >= sizes.length || fetched >= MAX_MEDIA_BYTES
            const pump = async (): Promise<void> => {
              if (dead || pumping || !sb || sb.updating) return
              if (doneAll()) { if (!ended) { ended = true; safeEnd() } return }
              if (ahead() > HIGH_WATER) return
              pumping = true
              try {
                let n = 0, bytes = 0
                while (fi + n < sizes.length && bytes < BATCH_BYTES) { bytes += sizes[fi + n]; n++ }
                const data = await fetchRange(dash.urls, mediaBase + offsets[fi], mediaBase + offsets[fi] + bytes - 1, aborter.signal)
                if (dead) return
                await appendWait(sb, data, aborter.signal) // 先 append 成功
                fi += n; fetched += data.byteLength // 再推进游标（append 失败不越过未喂的 fragment）
              } catch (e) {
                if (dead) return
                console.debug('[BiliKit-Web Feed] MSE 补拉失败：', (e as Error)?.message) // 已缓冲部分仍可播/loop
                ended = true; safeEnd()
              } finally { pumping = false }
              if (!dead && !doneAll() && ahead() < LOW_WATER) void pump()
            }
            const onTU: EventListener = () => void pump()
            const onWait: EventListener = () => {
              // MMS 可能回收已缓冲区间：播放头落到已释放处 → 跳到可用起点，避免 loop 后永久卡死
              try { const b = video.buffered; if (b.length && video.currentTime < b.start(0)) video.currentTime = b.start(0) } catch { /* ignore */ }
              void pump()
            }
            video.addEventListener('timeupdate', onTU); pumpListeners.push(['timeupdate', onTU])
            video.addEventListener('waiting', onWait); pumpListeners.push(['waiting', onWait])
            await pump() // 首批
          }
          if (dead) return
          video.play().catch((e) => console.debug('[BiliKit-Web Feed] MSE play() rej', (e as Error)?.name))
          playWatch = setTimeout(() => { console.debug('[BiliKit-Web Feed] MSE 起播看门狗超时 rs=', video.readyState); finish(false) }, PLAY_WATCH)
        } catch (e) {
          if (dead) return
          console.debug('[BiliKit-Web Feed] MSE 装载失败：', (e as Error)?.message || e)
          finish(false)
        }
      }, { once: true })
    } catch (e) {
      console.debug('[BiliKit-Web Feed] MSE 初始化失败：', (e as Error)?.message || e)
      finish(false)
    }
  })
}
