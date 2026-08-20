import type { FeedCard } from './app-api'

/**
 * 「当前页」打开视频前保存的轻量 Feed 快照。
 *
 * 视频仍走顶层导航，让 Safari 可以把完整视频页放进独立 WebContent 并在返回后回收；
 * sessionStorage 只负责把首页的数据游标与滚动位置接回来，不保活任何 DOM / iframe / 媒体资源。
 */
const KEY = 'bilikit:feed.return-session'
const VERSION = 1
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface FeedReturnSession {
  version: typeof VERSION
  savedAt: number
  source: 'app' | 'web'
  webFreshIdx: number
  exhausted: boolean
  scrollY: number
  items: FeedCard[]
}

function isCard(value: unknown): value is FeedCard {
  if (!value || typeof value !== 'object') return false
  const card = value as Partial<FeedCard>
  return typeof card.bvid === 'string' && !!card.bvid &&
    typeof card.title === 'string' && typeof card.cover === 'string' &&
    (card.source === 'app' || card.source === 'web')
}

export function parseFeedReturnSession(raw: string | null, now = Date.now()): FeedReturnSession | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<FeedReturnSession>
    if (value.version !== VERSION || typeof value.savedAt !== 'number' || now - value.savedAt > MAX_AGE_MS || value.savedAt > now + 60_000) return null
    if (value.source !== 'app' && value.source !== 'web') return null
    if (!Array.isArray(value.items) || !value.items.length || !value.items.every(isCard)) return null
    return {
      version: VERSION,
      savedAt: value.savedAt,
      source: value.source,
      webFreshIdx: Math.max(1, Math.floor(Number(value.webFreshIdx) || 1)),
      exhausted: value.exhausted === true,
      scrollY: Math.max(0, Number(value.scrollY) || 0),
      items: value.items,
    }
  } catch {
    return null
  }
}

export function saveFeedReturnSession(
  session: Omit<FeedReturnSession, 'version' | 'savedAt'>,
  storage: Storage = sessionStorage,
  now = Date.now(),
): boolean {
  try {
    const value: FeedReturnSession = { version: VERSION, savedAt: now, ...session }
    storage.setItem(KEY, JSON.stringify(value))
    return true
  } catch (error) {
    // 隐私模式 / 配额不足时不阻断导航；只是退化为普通的当前页往返。
    console.warn('[BiliKit-Web Feed] 保存返回状态失败，将按普通当前页导航：', error)
    return false
  }
}

/** 首页真正接管成功时才消费，避免原生 DOM 尚未出现就丢掉快照。 */
export function takeFeedReturnSession(now = Date.now(), storage: Storage = sessionStorage): FeedReturnSession | null {
  let raw: string | null
  try { raw = storage.getItem(KEY) } catch { return null }
  const value = parseFeedReturnSession(raw, now)
  try { storage.removeItem(KEY) } catch { /* ignore */ }
  return value
}
