import { fetchAppFeed, fetchWebFeed, type FeedCard } from './app-api'
import { NS, BLANK } from './shared'
import { injectStyle, hideNativeChrome } from './styles'
import { makeCard, makeSkeleton } from './card'
import { mountControls } from './controls'
import { FEED_VERSION } from './version'
import { saveFeedReturnSession, takeFeedReturnSession } from './return-session'

/**
 * App 推荐 feed 就地接管首页（编排层）：
 *  - 找到 B 站原生推荐流容器 → 隐藏 → 在原位挂我们自己的网格；
 *  - 窗口化：items[] 存全量数据，只渲染可视 ±1.5 屏的卡片节点、上下用占位撑高，DOM 数量有界；
 *  - 封面 IntersectionObserver 懒加载 + 屏外卸载（砍解码位图内存）；
 *  - 触底加载下一页；本会话 bvid 去重。
 * 样式/卡片/hover 预览/悬浮按钮已拆到 styles.ts / card.ts / hover-preview.ts / controls.ts。
 * 运行在隔离世界（@grant GM.xmlHttpRequest）——全程只操作 DOM，不读页面 JS。
 */
const seen = new Set<string>() // 已展示 bvid，去重
let grid: HTMLElement | null = null
let sentinel: HTMLElement | null = null
let topSpacer: HTMLElement | null = null // 窗口上方未渲染行的占位
let bottomSpacer: HTMLElement | null = null // 窗口下方未渲染行的占位
let loading = false
let exhausted = false // 匿名固定池刷完（连续多页无新内容）→ 停止并提示
let cardIo: IntersectionObserver | null = null
let sentinelIo: IntersectionObserver | null = null
let gridRo: ResizeObserver | null = null // 监视 grid 宽变（列数/行高随宽变），仅宽变才作废布局缓存
let lastGridW = 0
let feedGen = 0 // 代际令牌：每次重新接管/刷新自增；在途 loadMore 察觉代际变化即作废，避免竞态写入新 grid
// 虚拟化地基（P1）：items 为全量数据真源，nodes 为「下标 → 已渲染卡片节点」。
// P1 阶段 render() 仍全量渲染（等价现状）；P2 起改为只渲染可视窗口。
const items: FeedCard[] = []
const nodes = new Map<number, HTMLElement>()
// FeedCard 数据比 DOM/媒体轻很多，但仍不应在数小时会话里无界增长。
// 2000 张已远超正常单次浏览量；触顶后保留完整的向上回滚，用刷新开新会话。
const MAX_ITEMS = 2000
let cachedCols = 1 // 上次量到的有效列数（getComputedStyle 偶发返回未解析值时回落用）
// 布局量缓存：纯滚动时列数/行高/grid 顶偏移都不变，缓存后免得每帧 getComputedStyle + offsetHeight + BCR。
// resize / 重建 grid / 插提示条时经 invalidateLayout() 置脏重量。
let cachedRowH = 0 // 行高（卡高+行距），量到真卡后缓存
let cachedGridTop = 0 // grid 内容起点的文档偏移（从 topSpacer 量，天然排除顶部提示条高度）
let metricsDirty = true
let lastStart = -1, lastEnd = -1, lastTotalRows = -1 // 上次窗口；三者都没变则整帧早退（零 layout、零 DOM）
let renderRaf = 0
let suppressScroll = false // 补偿 scrollBy 会触发一次 scroll 事件，用它跳过、免得再引发一轮 render
let cooldownUntil = 0 // 加载失败后的退避截止时刻（performance.now），期间不重试，避免疯狂打 API

// 推荐源：'app'（app.bilibili.com，access_key）/ 'web'（web wbi 接口，cookie 个性化）。持久化在独立 key，
// 是 UI 态、不进 Core 设置面板。web 流按 fresh_idx 递增翻页（有状态），app 流无状态。
type Source = 'app' | 'web'
let source: Source = ((): Source => { try { return localStorage.getItem('bilikit:feed.tab') === 'web' ? 'web' : 'app' } catch { return 'app' } })()
let webFreshIdx = 1

function getAccessKey(): string {
  try {
    return (JSON.parse(localStorage.getItem('bilikit:settings') || '{}') as any)['feed.accessKey'] || ''
  } catch {
    return ''
  }
}

// 按页面真实底色(--bg2 亮度)判深浅——比 @media prefers-color-scheme 可靠（系统浅/B站深也能对）。
// 探针元素解析出 var(--bg2) 的实际 rgb，算感知亮度。骨架高光据此选亮/暗扫光。
let darkProbe: HTMLElement | null = null
function pageIsDark(): boolean {
  if (!darkProbe) {
    darkProbe = document.createElement('div')
    darkProbe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;background:var(--bg2,#fff);pointer-events:none'
    ;(document.body || document.documentElement).appendChild(darkProbe)
  }
  const m = getComputedStyle(darkProbe).backgroundColor.match(/\d+(?:\.\d+)?/g)
  if (!m) return false
  return 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2] < 128
}

// 量当前列数、「行高」（卡片高 + 行间距）与 grid 内容起点偏移。列数从 grid 计算样式取——正常已解析成
// px 列表，逐个数；偶发未解析(含 repeat/minmax 等非 px)则回落到上次有效值。行高量一张已渲染卡（卡等高，任取）。
// 缓存：量到「真卡」（offsetHeight>50）后才落缓存并清脏——否则会把无卡时的回落值 330 固化。
// 缓存有效期内直接返回，纯滚动帧不再做 getComputedStyle / offsetHeight / BCR。
function metrics(): { cols: number; rowH: number; gridTop: number } {
  if (!metricsDirty && cachedRowH > 0) return { cols: cachedCols, rowH: cachedRowH, gridTop: cachedGridTop }
  const cs = getComputedStyle(grid!)
  const parts = cs.gridTemplateColumns.split(' ').filter(Boolean)
  const cols = parts.length && parts.every((p) => p.endsWith('px')) ? parts.length : cachedCols
  cachedCols = cols
  let cardH = 330 // 首次未量到时的回落估值
  let measured = false
  const first = nodes.size ? (nodes.values().next().value as HTMLElement) : null
  if (first && first.offsetHeight > 50) { cardH = first.offsetHeight; measured = true }
  const rowGap = parseFloat(cs.rowGap) || 22
  const rowH = cardH + rowGap
  // topSpacer 的文档顶偏移 = grid 内容起点（含滚动时其自身 top 恒定，只是高度撑开下方）
  const gridTop = topSpacer ? topSpacer.getBoundingClientRect().top + window.scrollY : 0
  if (measured) { cachedRowH = rowH; cachedGridTop = gridTop; metricsDirty = false }
  return { cols, rowH, gridTop }
}

// resize / 重建 grid / 插提示条后：布局量与上次窗口全部作废，下帧强制重量、重渲染。
function invalidateLayout(): void {
  metricsDirty = true
  lastStart = -1; lastEnd = -1; lastTotalRows = -1
}

// 卡片被移除前：拆掉其真视频预览（停 MSE 补拉、撤源、释放 objectURL），杜绝滚走后 zombie 补拉/泄漏。
function teardownCard(el: HTMLElement): void {
  const cover = el.querySelector(`.${NS}-cover`) as HTMLElement | null
  ;(cover as any)?.__bkTeardown?.()
}

// SPA 重接管会整块移除旧 grid；移除前必须逐卡走媒体 teardown，不能只 nodes.clear()。
// 否则脱离 DOM 不会触发 mouseleave，已挂的 video/MSE/objectURL 仍可能继续播放和补拉。
function teardownRenderedCards(): void {
  for (const el of nodes.values()) {
    cardIo?.unobserve(el)
    teardownCard(el)
    el.remove()
  }
  nodes.clear()
}

// 「当前页」打开视频前同步落一份纯数据快照。不要存 DOM、媒体、observer：返回体验连续，但视频页仍能
// 作为顶层文档独立回收（这正是 Safari 实测比 iframe 干净的路径）。sessionStorage 天然按标签页隔离。
function saveCurrentFeedForReturn(): void {
  if (!items.length) return
  saveFeedReturnSession({
    source,
    webFreshIdx,
    exhausted,
    scrollY: window.scrollY,
    items,
  })
}

// 窗口化渲染：只保留「可视 ±1.5 屏」范围内的卡片节点，范围外移除；上下占位撑起未渲染区高度。
// 按 item 下标 key、只在窗口边缘增删（绝不中途拿一个节点换内容）→ 无封面重载/闪烁。
function render(): void {
  if (!grid || !sentinel || !topSpacer || !bottomSpacer) return
  if (!items.length) { topSpacer.style.height = '0px'; bottomSpacer.style.height = '0px'; lastStart = lastEnd = lastTotalRows = -1; return }
  const { cols, rowH, gridTop } = metrics() // 缓存命中时零 layout；gridTop 从 topSpacer 量（排除提示条）
  const totalRows = Math.ceil(items.length / cols)
  const into = window.scrollY - gridTop // 已滚进 grid 的像素（负=grid 还在视口下方）
  const vh = window.innerHeight
  const BUF = vh * 1.5 // 视口上下各留 1.5 屏 buffer（封面提前加载，无 pop-in）
  const firstRow = Math.max(0, Math.floor((into - BUF) / rowH))
  const lastRow = Math.min(totalRows - 1, Math.max(0, Math.ceil((into + vh + BUF) / rowH)))
  const startIdx = firstRow * cols
  const endIdx = Math.min(items.length, (lastRow + 1) * cols) // 独占上界
  // 早退：可视窗口与总行数都没变 → 无需任何 DOM/占位改动。纯滚动的绝大多数帧走这里，全帧零成本。
  // 必须带 totalRows：置顶不动时新页 loadMore 追加数据、窗口下标不变，但底部占位要跟着长高。
  if (startIdx === lastStart && endIdx === lastEnd && totalRows === lastTotalRows) return
  lastStart = startIdx; lastEnd = endIdx; lastTotalRows = totalRows

  // 锚点补偿：仅当「窗口上方有占位」(firstRow>0) 时需要——顶部(首屏/刷新)时 firstRow=0 不补偿，
  // 免得与 refreshFeed 的 scrollTo(top) 打架、也不会误落在非顶部。
  // 单点锚：几何推出「当前视口顶那一行的首卡」(O(1))，避免每帧遍历全窗口读 BCR 造成布局抖动。
  // 用 offsetTop 而非 getBoundingClientRect().top：后者会把 CSS transform 算进去，若锚点卡恰好在
  // 两次测量之间 hover 状态变化（卡片 hover 有 translateY(-4px)），会测出几像素的假位移——代码信以为真
  // 拿 scrollBy 去"纠正"，等于让整页真的跟着抖一下，看起来就是"划过一张卡，其它卡的文字跟着晃"。
  // offsetTop 是纯布局属性、不受 transform 影响，只在真实布局位置变化（窗口化增删节点撑高占位）时才变。
  const anchor = firstRow > 0 ? nodes.get(Math.max(0, Math.floor(into / rowH)) * cols) || null : null
  const anchorTop = anchor ? anchor.offsetTop : 0

  // 1) 移除窗口外节点（连同 observer/监听器/闭包一起 GC）
  for (const [i, el] of nodes) {
    if (i < startIdx || i >= endIdx) { cardIo?.unobserve(el); teardownCard(el); el.remove(); nodes.delete(i) }
  }
  // 2) 占位高度 = 未渲染行数 × 行高
  topSpacer.style.height = firstRow * rowH + 'px'
  bottomSpacer.style.height = Math.max(0, (totalRows - (lastRow + 1)) * rowH) + 'px'
  // 3) 补齐窗口内缺失节点：升序建卡，插到「下一个更高的已存在节点」前，否则底部占位前 → 保持顺序
  for (let i = startIdx; i < endIdx; i++) {
    if (nodes.has(i)) continue
    const el = makeCard(items[i], saveCurrentFeedForReturn)
    nodes.set(i, el)
    let ref: HTMLElement = bottomSpacer
    for (let j = i + 1; j < endIdx; j++) { const n = nodes.get(j); if (n) { ref = n; break } }
    grid.insertBefore(el, ref)
    cardIo?.observe(el)
  }
  // 4) 补偿：锚点渲染后若位移 >0.5px，反向滚回保持可见内容不动（同帧完成，无中间态）。
  //    置 suppressScroll 跳过这次 scrollBy 触发的 scroll，免得再引发一轮 render（估算准时 delta≈0，通常不触发）。
  if (anchor) {
    const delta = anchor.offsetTop - anchorTop
    if (Math.abs(delta) > 0.5) { suppressScroll = true; window.scrollBy(0, delta) }
  }
}

// scroll/resize 用 rAF 节流地重算窗口
function scheduleRender(): void {
  if (suppressScroll) { suppressScroll = false; return } // 跳过补偿 scrollBy 自己触发的这次 scroll
  if (renderRaf) return
  renderRaf = requestAnimationFrame(() => { renderRaf = 0; render() })
}

// 清空全部已渲染卡片与数据（刷新/重新接管时用）
function clearAll(): void {
  if (cardIo) cardIo.disconnect() // 解除对旧卡的观察，避免 observer 持有已删除节点（泄漏）
  teardownRenderedCards()
  items.length = 0
  if (topSpacer) topSpacer.style.height = '0px'
  if (bottomSpacer) bottomSpacer.style.height = '0px'
  invalidateLayout() // 卡片清空 → 上次窗口作废，下次填充从头重渲染
}

function renderSkeletons(n: number): void {
  if (!grid || !bottomSpacer) return
  const frag = document.createDocumentFragment()
  for (let i = 0; i < n; i++) frag.appendChild(makeSkeleton())
  grid.insertBefore(frag, bottomSpacer) // 骨架落在两占位之间（此时占位高度为 0）
}

function clearSkeletons(): void {
  if (grid) grid.querySelectorAll(`.${NS}-skcard`).forEach((n) => n.remove())
}

// 哨兵是否还在「加载区」内。填充目标必须 > 哨兵 IO 的触发区(innerH+1000)，否则填完哨兵仍在 IO 区内、
// IO 不再产生跨越事件 → 触底加载卡住。取 innerH + max(innerH, 1200)：大屏≈两屏、短屏也稳超触发区。
function sentinelInView(): boolean {
  if (!sentinel) return false
  return sentinel.getBoundingClientRect().top < window.innerHeight + Math.max(window.innerHeight, 1200)
}

function showTip(text: string): void {
  if (!grid) return
  let tip = grid.querySelector(`.${NS}-tip`) as HTMLElement | null
  if (!tip) { tip = document.createElement('div'); tip.className = `${NS}-tip`; grid.appendChild(tip) }
  tip.textContent = text
}

function removeTip(): void {
  grid?.querySelector(`.${NS}-tip`)?.remove()
}

// 是否已有真实卡片（骨架 .skcard 不算）——用于判定「首屏就失败」
function hasRealCard(): boolean {
  return !!grid && !!grid.querySelector(`.${NS}-card:not(.${NS}-skcard)`)
}

async function loadMore(): Promise<void> {
  if (loading || exhausted || !grid || !sentinel) return
  if (performance.now() < cooldownUntil) return // 上次失败后的退避期内不重试，避免持续错误时疯狂打 API
  loading = true
  const gen = feedGen // 记录本次代际；重新接管/刷新会改变它 → 本次作废
  let failed = false
  try {
    let emptyStreak = 0
    // 至少强制拉一页（first）：骨架占位会撑高哨兵，若只看 sentinelInView 窄视口下可能一页都不拉。
    // 之后再按「哨兵是否仍在加载区」决定是否继续，直到填满或连续 3 页无新内容（匿名池耗尽）。
    let first = true
    while ((first || sentinelInView()) && emptyStreak < 3 && items.length < MAX_ITEMS) {
      first = false
      // 按当前源分派：app 无状态、web 递增 fresh_idx（先自增再拉，保证每页页码不同）
      const { code, message, cards } = source === 'web'
        ? await fetchWebFeed(webFreshIdx++)
        : await fetchAppFeed(getAccessKey())
      if (gen !== feedGen) return // 期间发生了重新接管/刷新，本次已过期，交给新一轮（finally 不清新代的状态）
      if (code !== 0) { console.warn(`[BiliKit-Web Feed] 加载失败 code=${code} ${message}`); failed = true; break }
      clearSkeletons() // 拿到数据后立刻撤骨架：否则骨架占位高度会撑出哨兵，导致填充循环提前退出
      removeTip() // 有新数据 → 撤掉上一次的「失败/刷完」提示
      // 新卡去重后推入 items（数据真源），再 render() 落成节点（P1 全量）
      let addedThisPage = 0
      for (const c of cards) {
        if (!c.bvid || seen.has(c.bvid)) continue
        seen.add(c.bvid)
        items.push(c)
        addedThisPage++
        if (items.length >= MAX_ITEMS) break
      }
      if (addedThisPage) render()
      emptyStreak = addedThisPage === 0 ? emptyStreak + 1 : 0
    }
    if (items.length >= MAX_ITEMS) {
      exhausted = true
      showTip(`本次已加载 ${MAX_ITEMS} 条，为限制长会话内存已暂停追加；刷新内容可继续。`)
    } else if (emptyStreak >= 3) {
      // 只有「app 源 + 匿名」才是固定内容池、会真刷完 → 锁死提示；web 源或已登录多为瞬时空/重复页，退避重试即可
      if (source === 'app' && !getAccessKey()) {
        exhausted = true
        showTip('匿名推荐已刷完（B 站给匿名请求的是固定内容池）。配置 access_key 可看个性化、不重复的推荐。')
      } else {
        cooldownUntil = performance.now() + 3000
      }
    }
  } catch (e) {
    console.error('[BiliKit-Web Feed] 加载出错：', e)
    failed = true
  } finally {
    if (gen === feedGen) {
      clearSkeletons()
      loading = false
      if (failed) cooldownUntil = performance.now() + 3000 // 失败退避：3s 内哨兵/滚动重触发也不重试
    } // 仅当仍是本代才清理，别踩到新一轮的状态
  }
  // 首屏就失败（一张真实卡都没有）时给出可见提示，而不是空白/永久骨架
  if (gen === feedGen && failed && !hasRealCard()) showTip('加载失败，请稍后重试；若持续失败可在设置里配置 access_key 或检查网络。')
}

// 刷新内容：清空当前卡片 + 重置去重/耗尽 → 回顶 → 重新拉。
function refreshFeed(btn?: HTMLElement): void {
  if (!grid || !sentinel) return
  feedGen++ // 作废在途的 loadMore，使刷新即便在加载中也能立即生效（不再静默失效）
  loading = false
  clearAll() // 清掉全部卡片节点 + items + 解除观察
  removeTip()
  seen.clear()
  exhausted = false
  webFreshIdx = 1 // web 源翻页从头开始
  cooldownUntil = 0 // 手动刷新清退避，立即重试
  renderSkeletons(12) // 刷新时也先铺骨架
  if (btn) {
    btn.classList.add('busy')
    // loadMore 是异步循环，拉完首屏后解除转圈
    void loadMore().finally(() => btn.classList.remove('busy'))
  } else {
    void loadMore()
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 切源：app ↔ web。同源则无操作；换源即持久化 + 重置 web 页码 + 走 refreshFeed 全套重置重拉。
// 由右下角 FAB 的源切换器调用（其 UI 高亮由 controls.ts 自己维护，这里只管数据 + 刷新）。
function switchSource(s: Source): void {
  if (s === source) return
  source = s
  try { localStorage.setItem('bilikit:feed.tab', s) } catch { /* 隐私模式忽略 */ }
  webFreshIdx = 1
  refreshFeed()
}

function findNativeFeed(): HTMLElement | null {
  const card = document.querySelector('.feed-card, .bili-video-card')
  const byCard = card && (card.closest('.container') as HTMLElement | null)
  if (byCard) return byCard
  return (
    ([...document.querySelectorAll('.container')].find((c) => c.querySelector('.feed-card, .bili-video-card')) as HTMLElement) ||
    null
  )
}

/** 接管：隐藏原生流，在原位挂我们的网格。已挂或找不到则跳过。返回是否已就绪。 */
function takeover(): boolean {
  if (grid && grid.isConnected) return true
  const native = findNativeFeed()
  if (!native || !native.parentElement) return false

  // 重新接管前清理上一次的残留（SPA 重入首页）
  if (gridRo) { gridRo.disconnect(); gridRo = null }
  if (cardIo) cardIo.disconnect()
  if (sentinelIo) sentinelIo.disconnect()
  if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0 }
  teardownRenderedCards()
  document.querySelectorAll(`.${NS}`).forEach((g) => g.remove()) // 移除旧/孤儿 grid，防止重复网格
  feedGen++ // 作废在途的 loadMore（SPA 重入撞上在途加载时的竞态）
  loading = false
  items.length = 0
  seen.clear()
  exhausted = false
  cooldownUntil = 0
  invalidateLayout() // 新 grid：列数/行高/顶偏移都需重量

  // 只有找到了原生首页容器、确定本次能够接管，才消费返回快照。过期/损坏会返回 null。
  const returnSession = takeFeedReturnSession()
  if (returnSession) {
    source = returnSession.source
    webFreshIdx = returnSession.webFreshIdx
    exhausted = returnSession.exhausted
    items.push(...returnSession.items.slice(0, MAX_ITEMS))
    for (const card of items) seen.add(card.bvid)
  }

  injectStyle()
  native.style.setProperty('display', 'none', 'important')

  // 封面懒加载/屏外卸载：卡进视口前 1000px 载图，远离(仍在窗口内)则卸成 BLANK 释放位图。
  // 窗口化已负责增删节点，这里只管窗口内节点的封面位图内存。
  cardIo = new IntersectionObserver(
    (ents) => {
      for (const e of ents) {
        const card = e.target as HTMLElement
        const img = card.querySelector('img') as HTMLImageElement | null
        // 封面 <picture> 的 <source> 也得随 <img> 同步懒加载/卸载（见 card.ts 注释）：设置 img.src 会
        // 重新触发浏览器的 <picture> 源选择，届时才读 <source> 当前的 srcset——所以「进视口」必须先把
        // data-srcset 填回 srcset（让浏览器选中它）、再设 img.src；「离视口」必须先清空 srcset（不然
        // img.src 改回 BLANK 时选择算法还是会命中 source、又把大图重新拉一遍，等于白卸载）。
        const sources = card.querySelectorAll('picture source[data-srcset]')
        if (e.isIntersecting) {
          if (img && (!img.getAttribute('src') || img.src.startsWith('data:')) && img.dataset.src) {
            img.parentElement?.classList.remove('failed') // 重新加载 → 清掉上次的失败态，给一次重试
            sources.forEach((s) => { const ss = (s as HTMLSourceElement).dataset.srcset; if (ss) (s as HTMLSourceElement).srcset = ss })
            img.src = img.dataset.src
          }
        } else {
          if (img && img.src && !img.src.startsWith('data:')) {
            sources.forEach((s) => { (s as HTMLSourceElement).srcset = '' })
            img.src = BLANK
          }
        }
      }
    },
    { rootMargin: '1000px 0px' },
  )

  grid = document.createElement('div')
  grid.className = NS
  grid.classList.toggle('bk-dark', pageIsDark()) // 骨架高光按真实底色选亮/暗扫光
  topSpacer = document.createElement('div'); topSpacer.className = `${NS}-spacer`
  bottomSpacer = document.createElement('div'); bottomSpacer.className = `${NS}-spacer`
  sentinel = document.createElement('div'); sentinel.className = `${NS}-sentinel`
  // 顺序：上占位 → (卡片) → 下占位 → 哨兵。卡片由 render() 插在两占位之间。
  grid.append(topSpacer, bottomSpacer, sentinel)
  native.parentElement.insertBefore(grid, native)

  sentinelIo = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore() }, { rootMargin: '1000px 0px' })
  sentinelIo.observe(sentinel)

  // grid 宽变（窗口 resize、侧栏收放、缩放）→ 列数/行高会变 → 作废布局缓存重量。
  // 只认「宽」变：grid 高度会随占位/卡片每帧变，若也响应会与 render 自身的高度改动形成反馈、令缓存失效。
  lastGridW = 0
  if ('ResizeObserver' in window) {
    gridRo = new ResizeObserver((es) => {
      const w = es[0].contentRect.width
      if (w && w !== lastGridW) { lastGridW = w; invalidateLayout(); scheduleRender() }
    })
    gridRo.observe(grid)
  }

  // 右下角 FAB：源切换（手机 App/电脑 Web，hover 展胶囊）+ 刷新 + 返回顶部
  mountControls((btn) => refreshFeed(btn), { initial: source, onSwitch: switchSource })
  if (returnSession) {
    const scrollY = returnSession.scrollY
    // 首帧先建卡得到真实行高，再滚回保存位置；随后 scroll/IO 会重算深处窗口并按需续页。
    render()
    requestAnimationFrame(() => {
      invalidateLayout()
      render()
      window.scrollTo(0, scrollY)
      scheduleRender()
      if (!exhausted && sentinelInView()) void loadMore()
    })
  } else {
    renderSkeletons(12) // 数据到达前先铺骨架占位，避免空白
    void loadMore() // 循环内会一直拉到填满首屏（哨兵离开加载区）
  }
  return true
}

const REPO = 'https://github.com/shiinayane/BiliKit-Web'

// 未检测到 Core → 顶部插一条可关闭提示条（登录/设置/抽屉净化都靠 Core）。记住关闭，不再骚扰。
function warnCoreMissing(): void {
  if (!grid || !topSpacer) return
  if (localStorage.getItem('bilikit:dismiss.core-missing') || grid.querySelector(`.${NS}-warn`)) return
  const bar = document.createElement('div')
  bar.className = `${NS}-warn`
  bar.innerHTML =
    `<span>未检测到 <b>BiliKit-Web Core</b>：登录、设置、抽屉净化都需要它。</span>` +
    `<a href="${REPO}" target="_blank" rel="noopener">前往安装</a>` +
    `<button class="bk-x" aria-label="关闭">✕</button>`
  bar.querySelector('.bk-x')!.addEventListener('click', () => {
    try { localStorage.setItem('bilikit:dismiss.core-missing', '1') } catch { /* 隐私模式忽略 */ }
    bar.remove()
  })
  grid.insertBefore(bar, topSpacer) // 置顶；窗口渲染只管两占位之间，不动它
  invalidateLayout() // 提示条把 topSpacer 往下顶了 → gridTop 变，需重量（也修正锚点偏移）
}

// Core 心跳新鲜 = 已安装并在跑；否则提示安装
function checkCore(): void {
  const alive = Number(localStorage.getItem('bilikit:alive.core') || 0)
  if (Date.now() - alive > 15000) warnCoreMissing()
}

/** 只在首页顶层窗口生效；SPA 出入首页后原生流可能重建，轮询补挂。 */
export function mountFeed(): void {
  if (window.top !== window.self) return
  const beat = () => { try { localStorage.setItem('bilikit:alive.feed', String(Date.now())) } catch { /* 隐私模式忽略 */ } } // 心跳，供 Core 探测
  beat()
  let lastHeartbeatAt = Date.now()
  try { localStorage.setItem('bilikit:feed.version', FEED_VERSION) } catch { /* 隐私模式忽略 */ } // 供 Core「关于」页显示 Feed 版本
  // 窗口化：滚动/改窗都重算可视范围（rAF 节流；render 内部有 grid 空判）。resize 还要作废布局缓存。
  window.addEventListener('scroll', scheduleRender, { passive: true })
  window.addEventListener('resize', () => { invalidateLayout(); scheduleRender() })
  // 主题深浅：改事件驱动——盯 <html> class（Core 换肤会 toggle bili_dark/night-mode），变了才重算，
  // rAF 合并连发。取代原先每秒一次的 getComputedStyle 空转（首帧深浅由 takeover 内已 toggle 好）。
  let themeRaf = 0
  const syncDark = () => {
    if (themeRaf) return
    themeRaf = requestAnimationFrame(() => { themeRaf = 0; if (grid) grid.classList.toggle('bk-dark', pageIsDark()) })
  }
  try { new MutationObserver(syncDark).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }) } catch { /* ignore */ }
  const onHome = () => location.pathname === '/' || location.pathname === '/index.html'
  const tick = () => { if (onHome()) { hideNativeChrome(); takeover() } }
  tick()
  setTimeout(() => { if (onHome()) checkCore() }, 2500) // 延迟等 Core 心跳就位后再判断是否缺失
  // 低频常驻：Feed userscript 从首页进入后会跨 SPA 路由继续存活，故不能在 10 分钟后停掉；
  // 否则心跳会让 Core 误报「未安装」，后续首页 DOM 重建也无法补挂。2s 一次只做 pathname/单例早退，
  // 首页每约 6s 写一次心跳（Core 判定阈值 15s），非首页只做一次字符串判断。
  setInterval(() => {
    if (!onHome()) return
    const now = Date.now()
    if (now - lastHeartbeatAt >= 5000) { beat(); lastHeartbeatAt = now }
    hideNativeChrome()
    takeover() // 挂上了继续轮询以应对 SPA 重建
  }, 2000)
}
