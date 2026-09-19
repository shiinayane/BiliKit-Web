import { afterEach, describe, expect, it } from 'vitest'
import { installNetHook, type NetRule } from './net-hook'

class FakeXHR {
  opens: any[][] = []
  sends: any[] = []
  sentHeaders: [string, string][] = []
  aborts = 0
  readyState = 0
  responseType = ''
  withCredentials = false

  open(...args: any[]): void { this.opens.push(args); this.readyState = 1 }
  setRequestHeader(name: string, value: string): void { this.sentHeaders.push([name, value]) }
  send(body?: any): void { this.sends.push(body); this.readyState = 2 }
  abort(): void { this.aborts++; this.readyState = 0 }
  get responseText(): string { return '' }
  get response(): unknown { return null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function install(rule: NetRule): typeof FakeXHR {
  const fakeWindow = { XMLHttpRequest: FakeXHR, fetch: undefined } as any
  ;(globalThis as any).window = fakeWindow
  installNetHook([rule])
  return fakeWindow.XMLHttpRequest
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

afterEach(() => {
  delete (globalThis as any).window
})

describe('installNetHook XHR awaitRewrite', () => {
  it('abort 后异步改写返回也不会复活并发送旧请求', async () => {
    const d = deferred<{ url: string } | undefined>()
    const XHR = install({ match: () => true, awaitRewrite: () => d.promise })
    const xhr = new XHR() as FakeXHR
    xhr.open('GET', '/old')
    xhr.send('old-body')
    xhr.abort()

    d.resolve({ url: '/signed-old' })
    await flush()

    expect(xhr.aborts).toBe(1)
    expect(xhr.opens).toEqual([['GET', '/old']])
    expect(xhr.sends).toEqual([])
  })

  it('同一 XHR 再次 open 后，上一代异步结果不会污染新请求', async () => {
    const d = deferred<{ url: string } | undefined>()
    const XHR = install({ match: (url) => url === '/old', awaitRewrite: () => d.promise })
    const xhr = new XHR() as FakeXHR
    xhr.open('GET', '/old')
    xhr.send('old-body')
    xhr.open('GET', '/new')
    xhr.send('new-body')

    d.resolve({ url: '/signed-old' })
    await flush()

    expect(xhr.opens).toEqual([['GET', '/old'], ['GET', '/new']])
    expect(xhr.sends).toEqual(['new-body'])
  })

  it('改写重开时保留完整 open 参数并回放请求头', async () => {
    const d = deferred<{ url: string; credentials: RequestCredentials } | undefined>()
    const XHR = install({ match: () => true, awaitRewrite: () => d.promise })
    const xhr = new XHR() as FakeXHR
    xhr.open('GET', '/old', false, 'alice', 'secret')
    xhr.setRequestHeader('X-Test', 'yes')
    xhr.send()

    d.resolve({ url: '/signed', credentials: 'include' })
    await flush()

    expect(xhr.opens).toEqual([
      ['GET', '/old', false, 'alice', 'secret'],
      ['GET', '/signed', false, 'alice', 'secret'],
    ])
    expect(xhr.sentHeaders).toEqual([['X-Test', 'yes'], ['X-Test', 'yes']])
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.sends).toEqual([undefined])
  })
})

describe('installNetHook fetch awaitRewrite', () => {
  function setup(rule: NetRule) {
    const calls: Array<[unknown, RequestInit | undefined]> = []
    const fakeWindow = { fetch: async (input: unknown, init?: RequestInit) => {
      calls.push([input, init])
      return new Response('{}')
    } }
    ;(globalThis as any).window = fakeWindow
    installNetHook([rule])
    return { calls, fetch: fakeWindow.fetch }
  }

  it('冷启动等待改写，保留 Request 的调用方覆盖选项', async () => {
    const d = deferred<{ url: string } | undefined>()
    const { calls, fetch } = setup({ match: () => true, awaitRewrite: () => d.promise })
    const controller = new AbortController()
    const pending = fetch(new Request('https://example.test/original', { credentials: 'include' }), {
      credentials: 'omit', headers: { 'X-Fixture': 'override' }, signal: controller.signal,
    })
    expect(calls).toHaveLength(0)
    d.resolve({ url: 'https://example.test/upgraded' })
    await pending
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['https://example.test/upgraded', expect.objectContaining({
      credentials: 'omit', headers: { 'X-Fixture': 'override' }, signal: controller.signal,
    })])
  })

  it.each(['timeout', 'failure'])('%s 后只发送一次原请求', async (mode) => {
    const d = deferred<{ url: string } | undefined>()
    const { calls, fetch } = setup({ match: () => true, awaitRewrite: () => d.promise })
    const pending = fetch('/original')
    if (mode === 'timeout') d.resolve(undefined)
    else d.reject(new Error('unavailable'))
    await pending
    expect(calls).toEqual([['/original', undefined]])
  })

  it('等待期间取消立即拒绝，迟到的改写不会发请求', async () => {
    const d = deferred<{ url: string } | undefined>()
    const { calls, fetch } = setup({ match: () => true, awaitRewrite: () => d.promise })
    const controller = new AbortController()
    const pending = fetch(new Request('https://example.test/original', { signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    d.resolve({ url: '/late' })
    await flush()
    expect(calls).toHaveLength(0)
  })

  it('已有签名与未命中的请求不等待', async () => {
    let waits = 0
    const { calls, fetch } = setup({ match: (url) => url === '/matched',
      rewriteRequest: () => ({ url: '/ready' }), awaitRewrite: async () => { waits++; return undefined } })
    await fetch('/matched')
    await fetch('/other')
    expect(waits).toBe(0)
    expect(calls.map(([url]) => url)).toEqual(['/ready', '/other'])
  })
})
