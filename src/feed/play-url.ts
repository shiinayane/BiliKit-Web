import { gmRequest } from './app-api'
import { signWbi, WBI_REF } from '../lib/wbi'
import { readSetting } from './shared'

/**
 * 取封面 hover 预览用的取流信息（web wbi playurl，与原生 hover 同路、带 cookie 拿登录清晰度）：
 *  - getDashPreview：dash 最低清 AVC 轨的结构化信息（codecs + init/index 字节范围 + 镜像优先 url 候选），
 *    供 MSE 只抓 init + 首窗字节喂 <video>，起播快、流量省。
 *  - getDurlSources：durl 单文件 mp4 的直链候选，作 MSE 失败/不支持时的回退（<video src> 直喂）。
 * 主机偏好：优先 -mirror、踩低 mcdn/pcdn；命中 upos 系再 swap 成用户在 Core 选的镜像（海外提速），
 * 原始/备份保留作回退候选。
 */

// 复用 Core CDN 优选里用户选的镜像；缺省 hwb（与 cdn-pick 默认一致）
function targetMirror(): string {
  return readSetting<string>('module.cdn-pick.cfg.targetHost', 'upos-sz-mirrorhwb.bilivideo.com')
}

// 额外已知能服务 /v1/resource 的 upos 镜像（yt-dlp 实测），给去 PCDN 版多一个备选
const EXTRA_MIRROR = 'upos-sz-mirrorcoso1.bilivideo.com'

const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }
const pathOf = (u: string) => { try { return new URL(u).pathname } catch { return '' } }

// PCDN(P2P/省成本 CDN，403 拒外部 Range)：冷门视频常被分到这里。mcdn.bilivideo.cn/com、szbdyd.com、biliapi.net、/v1/resource/
function isPcdn(u: string): boolean {
  const h = hostOf(u)
  return /\.mcdn\.bilivideo\.(cn|com)$/i.test(h) || h.includes('mcdn') || /(^|\.)szbdyd\.com$/i.test(h) || /\.biliapi\.net$/i.test(h) || pathOf(u).startsWith('/v1/resource/')
}
const isUpos = (u: string) => /^upos-[^.]*\.bilivideo\.com$/i.test(hostOf(u))
// 换主机保留 path+query（签名在 query、与主机无关）；akamai 的 hdnts 绑主机不在此列，原样保留。
function swapTo(u: string, host: string): string {
  try { const x = new URL(u); x.protocol = 'https:'; x.host = host; return x.href } catch { return u }
}
const xyUsource = (u: string) => { try { return new URL(u).searchParams.get('xy_usource') || '' } catch { return '' } }

/**
 * 生成取字节的候选列表（首个最优、其余回退）。核心：把 upos 与 **PCDN(mcdn/szbdyd)** 都改写成
 * Range 友好的 upos 镜像直连——这是让**冷门视频也能 MSE**的关键（yt-dlp/BBDown 同法）。
 */
function prefer(urls: string[]): string[] {
  const mirror = targetMirror()
  const uniq = [...new Set(urls.filter(Boolean))]
  const out: string[] = []
  const push = (v: string) => { if (v && !out.includes(v)) out.push(v) }
  // 1) 非 PCDN 的 upos 源 → 用户镜像（最可靠）
  for (const u of uniq) if (!isPcdn(u) && isUpos(u)) push(swapTo(u, mirror))
  // 2) PCDN 源去化：szbdyd 优先用其 xy_usource 指定的真实 upos，再加用户镜像 + coso1
  for (const u of uniq) if (isPcdn(u)) {
    const xy = xyUsource(u); if (xy) push(swapTo(u, xy))
    push(swapTo(u, mirror))
    push(swapTo(u, EXTRA_MIRROR))
  }
  // 3) 原始候选回退（含 akamai 等不可换主机的）
  for (const u of uniq) push(u)
  return out
}

async function getCid(bvid: string, known?: string): Promise<string> {
  if (known) return known
  const t = await gmRequest({ method: 'GET', url: `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, headers: WBI_REF })
  return String(JSON.parse(t)?.data?.[0]?.cid || '')
}

async function requestPlayurl(bvid: string, cid: string, fnval: number, qn: number): Promise<any> {
  const query = await signWbi({ bvid, cid, qn, fnval, fnver: 0, fourk: 0 })
  if (!query) throw new Error('no wbi keys')
  const t = await gmRequest({ method: 'GET', url: `https://api.bilibili.com/x/player/wbi/playurl?${query}`, headers: WBI_REF })
  return JSON.parse(t)
}

export interface DashPreview {
  codecs: string       // SourceBuffer 的 codec 串，如 avc1.640032
  urls: string[]       // 镜像优先 + 回退候选
  initEnd: number      // init 段（ftyp+moov）末字节：Range 0-initEnd
  indexStart: number   // sidx 起始字节
  indexEnd: number     // sidx 末字节；媒体从 indexEnd+1 开始
}

// 解析 segment_base（兼容 snake/camel 两种字段名）为 {initEnd,indexStart,indexEnd}
function parseSeg(v: any): { initEnd: number; indexStart: number; indexEnd: number } | null {
  const sb = v.segment_base || v.SegmentBase || {}
  const init: string = sb.initialization || sb.Initialization || sb.range || ''
  const idx: string = sb.index_range || sb.indexRange || ''
  const [, initEndS] = init.split('-')
  const [idxStartS, idxEndS] = idx.split('-')
  const initEnd = Number(initEndS), indexStart = Number(idxStartS), indexEnd = Number(idxEndS)
  if (!Number.isFinite(initEnd) || !Number.isFinite(indexStart) || !Number.isFinite(indexEnd)) return null
  return { initEnd, indexStart, indexEnd }
}

const dashCache = new Map<string, DashPreview | null>()
const durlCache = new Map<string, string[] | null>()
const lru = (m: Map<string, unknown>) => { if (m.size > 150) m.delete(m.keys().next().value as string) }

/** dash 最低清 AVC 轨的 MSE 取流信息。无 AVC 返回 null（调用方回退 durl）。仅缓存「成功结果」（含合法「无AVC」）；
 *  异常（网络/风控/wbi 未就绪）不缓存，下次可重试——否则一次瞬时失败会把该卡永久钉死。 */
export async function getDashPreview(bvid: string, cid0?: string): Promise<DashPreview | null> {
  if (dashCache.has(bvid)) return dashCache.get(bvid)!
  let out: DashPreview | null = null
  let errored = false
  try {
    const cid = await getCid(bvid, cid0)
    if (!cid) throw new Error('no cid')
    const j = await requestPlayurl(bvid, cid, 16, 32) // dash
    const avc = (j?.data?.dash?.video || []).filter((v: any) => v.codecid === 7) // AVC，三家都能解
    if (avc.length) {
      const low = avc.sort((a: any, b: any) => (a.id || 0) - (b.id || 0))[0] // 最低清 → 分段最小
      const seg = parseSeg(low)
      if (seg && low.codecs) {
        out = { codecs: low.codecs, urls: prefer([low.baseUrl || low.base_url, ...(low.backupUrl || low.backup_url || [])]), ...seg }
      }
    }
  } catch (e) {
    errored = true
    console.warn('[BiliKit-Web Feed] dash 取流失败：', (e as Error)?.message || e)
  }
  if (!errored) { dashCache.set(bvid, out); lru(dashCache) } // 只缓存成功；异常不缓存 → 下次重试
  return out
}

/** durl 单文件 mp4（360P，恒 AVC）直链候选，供 MSE 失败时 <video src> 回退。仅缓存成功结果；异常不缓存。 */
export async function getDurlSources(bvid: string, cid0?: string): Promise<string[] | null> {
  if (durlCache.has(bvid)) return durlCache.get(bvid)!
  let sources: string[] | null = null
  let errored = false
  try {
    const cid = await getCid(bvid, cid0)
    if (!cid) throw new Error('no cid')
    const j = await requestPlayurl(bvid, cid, 1, 16) // mp4 durl 360p
    const durl = j?.data?.durl
    if (Array.isArray(durl) && durl.length) sources = prefer(durl.flatMap((x: any) => [x.url, ...(x.backup_url || [])]))
    else console.warn('[BiliKit-Web Feed] durl 为空 code=', j?.code, j?.message)
  } catch (e) {
    errored = true
    console.warn('[BiliKit-Web Feed] durl 取流失败：', (e as Error)?.message || e)
  }
  if (!errored) { durlCache.set(bvid, sources); lru(durlCache) }
  return sources
}
