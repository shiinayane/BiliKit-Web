import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../core/drawer', () => ({ openDrawer: vi.fn(), preconnect: vi.fn() }))
vi.mock('../../core/settings', () => ({ get: (_key: string, fallback: unknown) => fallback }))
import { resolveVideoClick } from './index'

// 小型离线 DOM 树：只实现本测试需要的标签、类名、属性和祖先查询，不模拟 Safari 事件。
class Node {
  children: Node[] = []
  parent: Node | null = null
  dataset: Record<string, string> = {}
  constructor(public tag: string, public classes = '', public href = '') {}
  add(...nodes: Node[]): this { nodes.forEach((n) => { n.parent = this; this.children.push(n) }); return this }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const s = part.trim()
      if (s.startsWith('.')) return this.classes.split(' ').includes(s.slice(1))
      if (s === 'a[href]') return this.tag === 'a' && !!this.href
      if (s === '[data-bvid]') return !!this.dataset.bvid
      return s === this.tag
    })
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap((n) => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)])
  }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null }
}
const url = 'https://www.bilibili.com/video/BV1fixture?p=2'
function resolve(node: Node) {
  vi.stubGlobal('location', { href: 'https://www.bilibili.com/v/popular/all' })
  return resolveVideoClick(node as unknown as Element)
}
afterEach(() => vi.unstubAllGlobals())

describe('video title routing', () => {
  it.each([['video-card', 'video-name'], ['bili-video-card', 'bili-video-card__info--tit']])(
    '%s 的无链接标题复用同卡视频地址，保留分 P', (cardClass, titleClass) => {
      const text = new Node('span')
      const title = new Node('h3', titleClass).add(text)
      new Node('div', cardClass).add(new Node('a', '', url), title)
      expect(resolve(text)?.url).toBe(url)
    })
  it('原生标题链接与封面保持一致', () => {
    const text = new Node('span')
    new Node('a', '', url).add(text)
    expect(resolve(text)?.url).toBe(url)
  })
  it.each(['up', 'button', 'blank', 'outside', 'ambiguous'])(
    '保守放行 %s', (kind) => {
      const title = new Node('h3', 'title')
      const card = new Node('div', 'video-card').add(new Node('a', '', url), title)
      let target = title
      if (kind === 'up') { target = new Node('a', '', 'https://space.bilibili.com/1'); title.add(target) }
      if (kind === 'button') { target = new Node('button'); title.add(target) }
      if (kind === 'blank') { target = new Node('div'); card.add(target) }
      if (kind === 'outside') target = new Node('h3', 'title')
      if (kind === 'ambiguous') card.add(new Node('a', '', 'https://www.bilibili.com/video/BV2fixture'))
      expect(resolve(target)).toBeNull()
    })
  it('Feed 操作区和非视频链接不被 data-bvid 吞掉', () => {
    const card = new Node('div'); card.dataset.bvid = 'BV1fixture'
    const action = new Node('div', 'bk-feed-noopen')
    const up = new Node('a', '', 'https://space.bilibili.com/1')
    card.add(action, up)
    expect(resolve(action)).toBeNull()
    expect(resolve(up)).toBeNull()
    expect(resolve(card)?.url).toBe('https://www.bilibili.com/video/BV1fixture')
  })
})
