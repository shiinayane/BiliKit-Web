import { openDrawer, preconnect } from '../../core/drawer'
import { get } from '../../core/settings'
import { isPlayPage } from '../../core/pages'
import {
  DEFAULT_NEW_TAB_HISTORY_FLATTEN,
  DEFAULT_OPEN_MODE,
  NEW_TAB_HISTORY_FLATTEN_KEY,
  openBiliKitVideoTab,
} from '../../core/new-tab'

/**
 * 全站抽屉：在任意 B 站页面（首页 / 搜索 / 收藏 / 历史 / 稍后看 / 别人空间 / 动态…）点视频，
 * 按「打开方式」(feed.openMode) 打开——抽屉 / 网页全屏抽屉 / 新标签 / 当前页(不拦)。不跳走、不丢当前列表。
 * 做法：document 上捕获阶段委托点击 → 命中视频链接就接管（复用 Core 抽屉）；非视频/修饰键点击一律放行。
 * 无独立开关，直接由「打开方式」驱动（当前页=不拦）；首页 Feed 卡片也走这里（卡片带 data-bvid）。
 * 例外：**视频播放页内不接管**（见 isPlayPage）——那里点相关视频走原生 SPA，喂给「回程」建栈、且不叠抽屉。
 * 只作用于「浏览/列表」语境（首页/搜索/空间/收藏/历史/动态…），播放页本就不该被抓进来。
 */
function isVideoUrl(u: string): boolean {
  try {
    const url = new URL(u, location.href)
    if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return false
    // 收紧：av 后须跟数字、BV 后须跟字母数字、ep/ss 后须跟数字——免得误吃 /video/average 之类
    return /^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(url.pathname) || /^\/bangumi\/play\/(ep|ss)\d+/i.test(url.pathname)
  } catch { return false }
}

// 从点击目标解析出「要打开的视频 URL(+可选封面)」；非视频 / 需放行 → null
export function resolveVideoClick(target: Element): { url: string; cover: string } | null {
  // Feed 卡片上的操作控件（稍后再看 / 我不想看菜单 / 撤销浮层）统一带 .bk-feed-noopen——放行、别当成「点视频」
  if (target.closest('.bk-feed-noopen')) return null
  const pick = (root: Element, url: string) => {
    const img = root.querySelector('img') as HTMLImageElement | null
    return { url, cover: (img && (img.currentSrc || img.src)) || '' }
  }
  // 原生链接优先；明确的非视频链接保持原生导航。
  const a = target.closest('a[href]') as HTMLAnchorElement | null
  if (a) return isVideoUrl(a.href) ? pick(a, a.href.split('#')[0]) : null
  // 2) Feed 卡片（div[data-bvid]）：排除头像 / UP 名区域（那些交给 Feed 自己进空间）
  const card = target.closest('[data-bvid]') as HTMLElement | null
  if (card && card.dataset.bvid && !target.closest('.bk-feed-face, .bk-feed-up')) {
    return pick(card, `https://www.bilibili.com/video/${card.dataset.bvid}`)
  }
  // 原生首页/热门卡片的标题可能只有站点点击处理器，没有自身 href。
  // 仅从明确的标题区域回溯到最近的视频卡片，复用该卡片唯一的视频目的地。
  // 不把整张卡片的空白、UP 信息或按钮都变成视频入口；多目的地时保守放行。
  if (target.closest('button, input, textarea, select, [role="button"], [contenteditable="true"]')) return null
  const title = target.closest('.bili-video-card__info--tit, .video-name, .video-title, .title')
  const nativeCard = title?.closest('.bili-video-card, .video-card')
  if (!nativeCard) return null
  const links = Array.from(nativeCard.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((link) => isVideoUrl(link.href))
  const destinations = new Set(links.map((link) => {
    const url = new URL(link.href, location.href)
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  }))
  if (destinations.size !== 1) return null
  return pick(nativeCard, links[0]!.href.split('#')[0])
}

export function installSiteDrawer(): void {
  if ((window as any).__BILIKIT_SITE_DRAWER__) return
  if (window.top !== window.self) return // 抽屉 / 嵌入 iframe 内不拦（让其内部点击照常导航）
  ;(window as any).__BILIKIT_SITE_DRAWER__ = true

  document.addEventListener('click', (e) => {
    // 播放页内点视频（相关推荐 / 播放列表下一个）一律放行走原生 SPA：既喂给「回程」建栈，又避免抽屉叠抽屉。
    // 按点击时的 pathname 现判——B 站 SPA 跳转会改 location 不重载，install 时定死会错。与回程站上的边界同源。
    if (isPlayPage()) return
    const mode = get<string>('feed.openMode', DEFAULT_OPEN_MODE)
    if (mode === 'current') return // 当前页 = 原生行为，不拦
    // 修饰键 / 中键 / 已被处理 → 放行（用户想要新标签 / 站点已接管）
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const target = e.target instanceof Element ? e.target : null
    const hit = target ? resolveVideoClick(target) : null
    if (!hit) return
    e.preventDefault()
    e.stopImmediatePropagation() // 抢在站点 SPA 路由之前完全接管这次点击，避免底层又导航一遍
    if (mode === 'newtab') {
      openBiliKitVideoTab(
        hit.url,
        get<boolean>(NEW_TAB_HISTORY_FLATTEN_KEY, DEFAULT_NEW_TAB_HISTORY_FLATTEN),
      )
      return
    }
    const web = mode === 'drawer-web'
    openDrawer(hit.url, hit.cover, web, web && get<boolean>('feed.drawerImmersive', true))
  }, true) // capture：先于站点自身 handler

  // 悬停视频链接预连接（省点开握手）：drawer 内部 12s 节流
  document.addEventListener('mouseover', (e) => {
    if (isPlayPage()) return // 播放页不接管 → 预连接纯属浪费
    const mode = get<string>('feed.openMode', DEFAULT_OPEN_MODE)
    if (mode !== 'drawer' && mode !== 'drawer-web') return
    if (e.target instanceof Element && resolveVideoClick(e.target)) preconnect()
  }, true)
}
