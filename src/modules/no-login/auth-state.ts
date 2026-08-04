import { md5 } from '../../lib/md5'

export type LoginStatus = 'valid' | 'invalid' | 'unknown'
export type InitialAuthAction = 'activate-guest' | 'skip' | 'verify'
export type VerifiedAuthAction = 'reload' | 'skip'

export const AUTH_CACHE_KEY = 'bilikit:no-login-auth'
const VALID_TTL_MS = 5 * 60 * 1000

interface AuthCacheRecord {
  fingerprint: string
  status: Exclude<LoginStatus, 'unknown'>
  checkedAt: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 精确读取 cookie 值，避免把相似名称或空值误判成真实登录标记。 */
export function cookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const item = part.trim()
    const eq = item.indexOf('=')
    if (eq < 0 || item.slice(0, eq) !== name) continue
    const value = item.slice(eq + 1)
    return value || null
  }
  return null
}

/** 缓存只存登录标记的摘要，不把原始 cookie 值复制进 Web Storage。 */
export function loginCookieFingerprint(cookie: string): string | null {
  const value = cookieValue(cookie, 'DedeUserID__ckMd5')
  return value ? md5(value) : null
}

function readCachedStatus(storage: StorageLike, fingerprint: string, now: number): LoginStatus {
  try {
    const record = JSON.parse(storage.getItem(AUTH_CACHE_KEY) || 'null') as AuthCacheRecord | null
    if (!record || record.fingerprint !== fingerprint) return 'unknown'
    if (record.status === 'invalid') return 'invalid' // 同一失效 cookie 在当前标签会话内无需反复验证/刷新
    if (record.status === 'valid' && now - record.checkedAt <= VALID_TTL_MS) return 'valid'
  } catch { /* ignore malformed/unavailable sessionStorage */ }
  return 'unknown'
}

export function initialAuthAction(cookie: string, storage: StorageLike, now = Date.now()): InitialAuthAction {
  const fingerprint = loginCookieFingerprint(cookie)
  if (!fingerprint) return 'activate-guest'
  const cached = readCachedStatus(storage, fingerprint, now)
  if (cached === 'invalid') return 'activate-guest'
  if (cached === 'valid') return 'skip'
  return 'verify'
}

/**
 * 只接受 nav 的明确登录结论。失效 cookie 会返回 code=-101 + isLogin=false（issue #5 的目标路径）；
 * 限流、风控、网络错误和异常结构保持 unknown，不得误伤可能存在的真登录。
 */
export function loginStatusFromNav(json: any): LoginStatus {
  if (json?.code === 0 && json?.data?.isLogin === true) return 'valid'
  if ((json?.code === 0 || json?.code === -101) && json?.data?.isLogin === false) return 'invalid'
  return 'unknown'
}

export async function verifyLogin(pureFetch: typeof fetch, timeoutMs = 2500): Promise<LoginStatus> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = pureFetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
    cache: 'no-store',
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) return 'unknown' as const
    return loginStatusFromNav(await response.json())
  }).catch(() => 'unknown' as const)
  const timeout = new Promise<LoginStatus>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('unknown')
    }, timeoutMs)
  })
  try { return await Promise.race([request, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

/**
 * 返回 reload 仅代表“失效状态已可靠写入 sessionStorage”，刷新后才能在 document-start
 * 及时安装 playinfo/fetch/XHR hook。写入失败时保守不刷新，避免形成循环。
 */
export function rememberVerifiedLogin(
  storage: StorageLike,
  fingerprint: string,
  status: LoginStatus,
  now = Date.now(),
): VerifiedAuthAction {
  if (status === 'unknown') return 'skip'
  try {
    const record: AuthCacheRecord = { fingerprint, status, checkedAt: now }
    storage.setItem(AUTH_CACHE_KEY, JSON.stringify(record))
    return status === 'invalid' ? 'reload' : 'skip'
  } catch { return 'skip' }
}
