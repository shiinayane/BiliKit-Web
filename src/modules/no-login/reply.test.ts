import { describe, it, expect } from 'vitest'
import { stripReplyDeviceParam } from './reply'

describe('stripReplyDeviceParam（免登录子评论翻页）', () => {
  it('去掉 x-bili-device-req-json，其余参数原样保留', () => {
    const out = stripReplyDeviceParam('//api.bilibili.com/x/v2/reply/reply?oid=1&type=1&root=2&ps=10&pn=2&x-bili-device-req-json=%7B%22platform%22%3A%22web%22%7D&web_location=333.788')
    expect(out).toBe('//api.bilibili.com/x/v2/reply/reply?oid=1&type=1&root=2&ps=10&pn=2&web_location=333.788')
  })

  it('不带该参数 → 不改 url', () => {
    expect(stripReplyDeviceParam('https://api.bilibili.com/x/v2/reply/reply?oid=1&pn=2')).toBeUndefined()
    expect(stripReplyDeviceParam('https://api.bilibili.com/x/v2/reply/reply')).toBeUndefined()
  })

  it('仅剩该参数 → 去掉整个查询串', () => {
    expect(stripReplyDeviceParam('/x/v2/reply/reply?x-bili-device-req-json=1')).toBe('/x/v2/reply/reply')
  })
})
