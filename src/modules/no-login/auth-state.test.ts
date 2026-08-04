import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_CACHE_KEY,
  cookieValue,
  initialAuthAction,
  loginCookieFingerprint,
  loginStatusFromNav,
  rememberVerifiedLogin,
  verifyLogin,
} from './auth-state'

function memoryStorage(initial?: string) {
  const data = new Map<string, string>()
  if (initial) data.set(AUTH_CACHE_KEY, initial)
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

describe('no-login auth state', () => {
  it('没有非空登录标记时立即启用访客模式', () => {
    const storage = memoryStorage()
    expect(initialAuthAction('', storage)).toBe('activate-guest')
    expect(initialAuthAction('DedeUserID__ckMd5=; foo=bar', storage)).toBe('activate-guest')
    expect(cookieValue('foo=1; DedeUserID__ckMd5=abc; bar=2', 'DedeUserID__ckMd5')).toBe('abc')
  })

  it('未知登录标记需要服务端确认，确认结果只匹配同一 cookie', () => {
    const storage = memoryStorage()
    const cookie = 'DedeUserID__ckMd5=old-session'
    const fingerprint = loginCookieFingerprint(cookie)!
    expect(initialAuthAction(cookie, storage, 100)).toBe('verify')
    expect(rememberVerifiedLogin(storage, fingerprint, 'invalid', 100)).toBe('reload')
    expect(initialAuthAction(cookie, storage, 200)).toBe('activate-guest')
    expect(initialAuthAction('DedeUserID__ckMd5=new-session', storage, 200)).toBe('verify')
  })

  it('真登录短期缓存让路，过期后重新确认', () => {
    const storage = memoryStorage()
    const cookie = 'DedeUserID__ckMd5=live-session'
    const fingerprint = loginCookieFingerprint(cookie)!
    expect(rememberVerifiedLogin(storage, fingerprint, 'valid', 1_000)).toBe('skip')
    expect(initialAuthAction(cookie, storage, 1_000 + 60_000)).toBe('skip')
    expect(initialAuthAction(cookie, storage, 1_000 + 6 * 60_000)).toBe('verify')
  })

  it('异常响应和存储失败都保守跳过，不触发刷新', () => {
    expect(loginStatusFromNav({ code: -101, data: { isLogin: false } })).toBe('invalid')
    expect(loginStatusFromNav({ code: -412, data: { isLogin: false } })).toBe('unknown')
    expect(loginStatusFromNav({ code: 0, data: {} })).toBe('unknown')
    const broken = {
      getItem: () => null,
      setItem: () => { throw new Error('blocked') },
    }
    expect(rememberVerifiedLogin(broken, 'fingerprint', 'invalid')).toBe('skip')
  })

  it('只以成功 nav 的 isLogin 布尔值判定登录状态', async () => {
    const validFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true } })))
    const invalidFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { isLogin: false } })))
    const failedFetch = vi.fn(async () => new Response('{}', { status: 503 }))

    await expect(verifyLogin(validFetch as any)).resolves.toBe('valid')
    await expect(verifyLogin(invalidFetch as any)).resolves.toBe('invalid')
    await expect(verifyLogin(failedFetch as any)).resolves.toBe('unknown')
    expect(validFetch).toHaveBeenCalledWith(
      'https://api.bilibili.com/x/web-interface/nav',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })

  it('nav 超时返回 unknown 并中止探测', async () => {
    let signal: AbortSignal | undefined
    const hangingFetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => { /* pending until abort */ })
    })
    await expect(verifyLogin(hangingFetch as any, 5)).resolves.toBe('unknown')
    expect(signal?.aborted).toBe(true)
  })
})
