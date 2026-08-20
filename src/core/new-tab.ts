export const DEFAULT_OPEN_MODE = 'newtab'
export const NEW_TAB_HISTORY_FLATTEN_KEY = 'feed.newTabHistoryFlatten'
export const DEFAULT_NEW_TAB_HISTORY_FLATTEN = false
export const WAYBACK_STACK_KEY = 'bilikit-wayback-stack'

const NEW_TAB_TARGET_PREFIX = 'bilikit-newtab-flatten-'
const NEW_TAB_TOKEN = /^[0-9a-z-]{8,}$/i

/** Safari 才有“链接自动打开的子标签在历史深度为 1 时，左滑关闭并回到来源标签”的行为。 */
export function isSafariUserAgent(userAgent: string, vendor: string): boolean {
  return /Safari/i.test(userAgent)
    && /Apple Computer/i.test(vendor)
    && !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS|OPiOS)/i.test(userAgent)
}

export function shouldUseSafariHistoryFlatten(
  enabled: boolean,
  userAgent: string,
  vendor: string,
): boolean {
  return enabled && isSafariUserAgent(userAgent, vendor)
}

function newToken(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
}

export function newHistoryFlattenTargetName(token = newToken()): string {
  return `${NEW_TAB_TARGET_PREFIX}${token}`
}

export function isHistoryFlattenTargetName(name: string): boolean {
  if (!name.startsWith(NEW_TAB_TARGET_PREFIX)) return false
  return NEW_TAB_TOKEN.test(name.slice(NEW_TAB_TARGET_PREFIX.length))
}

/**
 * 只在由 BiliKit-Web 自动打开的 Safari 视频标签上留下一个一次性 window.name 标记。
 *
 * 历史压扁需要保留 opener，才能使用 Safari 的原生左滑关闭行为；普通新标签仍坚持 noopener。
 * 打开前临时摘掉回程栈，避免 Safari 把来源标签的 sessionStorage 克隆进子标签。
 */
export function openBiliKitVideoTab(url: string, enableHistoryFlatten: boolean): Window | null {
  const flatten = shouldUseSafariHistoryFlatten(
    enableHistoryFlatten,
    navigator.userAgent,
    navigator.vendor,
  )
  if (!flatten) return window.open(url, '_blank', 'noopener')

  let previousStack: string | null = null
  try {
    previousStack = sessionStorage.getItem(WAYBACK_STACK_KEY)
    if (previousStack != null) sessionStorage.removeItem(WAYBACK_STACK_KEY)
  } catch { /* 存储不可用也不阻断打开 */ }

  try {
    // 唯一 target name 保证每次都是新 browsing context；不能加 noopener，否则 Safari 左滑只会两头落空。
    return window.open(url, newHistoryFlattenTargetName())
  } finally {
    try {
      if (previousStack != null) sessionStorage.setItem(WAYBACK_STACK_KEY, previousStack)
    } catch { /* ignore */ }
  }
}

/** 目标视频页 document-start 消费一次性标记；普通标签、当前页和抽屉永远返回 false。 */
export function consumeHistoryFlattenTarget(): boolean {
  if (window.top !== window.self || !isHistoryFlattenTargetName(window.name)) return false
  try { window.name = '' } catch { /* 即使清理失败，单例守卫也会防止本 Document 重装 */ }
  return true
}
