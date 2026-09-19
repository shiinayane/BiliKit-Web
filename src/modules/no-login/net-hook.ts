/**
 * 袖珍 fetch / XHR 拦截器——只服务 no-login 模块的固定几个接口，对其余请求**原样透传**。
 * 能力：按 URL 片段匹配 → 改请求(url / credentials) / 改响应(解析 JSON → 变形 → 回填)。
 * 覆盖 fetch 与 XHR 两条路（B 站 nav/reply 走 fetch、playurl/player 走 XHR）。
 *
 * 设计取舍：
 *  - 只处理 **GET** 接口（本模块用到的全是 GET），改请求时把 Request 归一成 (url, init)，不搬 body。
 *  - XHR 用 `class X extends OX` + 重写 responseText/response getter，与 cdn-pick 同一套（本仓库验证过）。
 *  - 与 cdn-pick 并存：非匹配 URL 一律 `apply` 原链，两个 Core hook 经 register() 定序、不抢。
 */

export interface NetRule {
  /** URL 命中判定 */
  match: (url: string) => boolean
  /** 改请求：返回新 url / credentials（都可选，不返回则不改） */
  rewriteRequest?: (url: string) => { url?: string; credentials?: RequestCredentials } | undefined
  /**
   * 异步改请求（fetch / XHR）：当同步 rewriteRequest 没拿到新 url（如 playurl 的 wbi key 还没暖好）时，
   * 请求会**推迟真正发送**、await 本函数拿到最终改写再发。拿不到（返回 undefined/超时）则按原始请求发出。
   * 用于「无痕会话首个视频 key 未就绪 → 首帧 480p」这类竞态：等 key 到了再签名，首个视频也能 1080p。
   */
  awaitRewrite?: (url: string) => Promise<{ url?: string; credentials?: RequestCredentials } | undefined>
  /** 改响应：拿到解析后的 JSON，返回变形后的对象（原地改或换新都行） */
  rewriteResponse?: (json: any, url: string) => any
}

const urlOf = (input: any): string => {
  if (typeof input === 'string') return input
  if (input && typeof input.url === 'string') return input.url // Request
  try { return String(input) } catch { return '' }
}

// 把 Request 归一成 init（仅搬 GET 安全字段：method/headers/credentials/signal；不搬 body。
// 不搬 mode——'navigate' 传给 fetch(url, {mode:'navigate'}) 会抛 TypeError，且本模块只改 GET API，默认 mode 即可）
function requestToInit(req: Request): RequestInit {
  const headers: Record<string, string> = {}
  try { req.headers.forEach((v, k) => { headers[k] = v }) } catch { /* ignore */ }
  return { method: req.method, headers, credentials: req.credentials, referrer: req.referrer, signal: req.signal }
}

export function installNetHook(rules: NetRule[]): void {
  if ((window as any).__BILIKIT_NET_HOOK__) return // 幂等：同一 window 只包一次，杜绝二次包裹致响应被改两遍
  ;(window as any).__BILIKIT_NET_HOOK__ = true

  // 一、fetch
  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = async function (input: any, init?: any) {
      const url = urlOf(input)
      const rule = rules.find((r) => r.match(url))
      if (!rule) return origFetch.apply(this, arguments as any)

      let realInput: any = input
      let realInit: any = init
      const signal: AbortSignal | undefined = init?.signal !== undefined
        ? init.signal : (input instanceof Request ? input.signal : undefined)
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      let rw = rule.rewriteRequest?.(url)
      if (!rw?.url && rule.awaitRewrite) {
        // 与 XHR 共用规则的有界等待；取消时立刻结束，迟到的签名不得再发请求。
        let onAbort: (() => void) | undefined
        try {
          const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
            signal?.addEventListener('abort', onAbort, { once: true })
          })
          rw = await Promise.race([rule.awaitRewrite(url), cancelled]) ?? rw
        } catch {
          if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
          // 签名失败或规则超时：保留原请求，仍可正常播放。
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort)
        }
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (rw && (rw.url || rw.credentials)) {
        if (input instanceof Request && !rw.url) {
          // 仅改 credentials（如 reply 走匿名）：用 Request 克隆构造，headers/body/signal/mode 原样保留、只覆盖 credentials
          realInput = new Request(input, rw.credentials ? { credentials: rw.credentials } : {})
          realInit = init
        } else {
          // 改了 url：归一成字符串 url + init（Request 的 body 仅 GET 接口，按设计不搬）
          const base = input instanceof Request ? { ...requestToInit(input), ...init } : (init || {})
          realInput = rw.url || url
          realInit = { ...base, ...(rw.credentials ? { credentials: rw.credentials } : {}) }
        }
      }
      const resp = await origFetch.call(this, realInput, realInit)
      if (!rule.rewriteResponse) return resp
      try {
        const text = await resp.clone().text()
        const out = rule.rewriteResponse(JSON.parse(text), url)
        const headers = new Headers(resp.headers)
        headers.delete('content-length') // 正文已解码、长度变了
        headers.delete('content-encoding') // 已不是原编码
        return new Response(JSON.stringify(out), { status: resp.status, statusText: resp.statusText, headers })
      } catch { return resp } // 非 JSON / 解析失败 → 原样返回
    } as any
  }

  // 二、XHR
  const OX = window.XMLHttpRequest
  if (OX) {
    class X extends OX {
      private __nlUrl = ''
      private __nlOpenArgs: [any, any, ...any[]] = ['GET', '']
      private __nlRule: NetRule | undefined
      private __nlRw: { url?: string; credentials?: RequestCredentials } | undefined
      private __nlHeaders: [string, string][] = [] // 记录请求头，供慢路径重开后回放（重开会清空请求头）
      private __nlGeneration = 0 // 每次 open/abort 递增；异步改写回来时只认发起它的同一代请求
      private __nlAborted = false
      open(method: any, url: any, ...rest: any[]) {
        this.__nlGeneration++ // 原生 open 会取消同一 XHR 上一次请求；同步作废尚在等待的异步改写
        this.__nlAborted = false
        this.__nlUrl = String(url)
        this.__nlOpenArgs = [method, url, ...rest]
        this.__nlHeaders = []
        this.__nlRule = rules.find((r) => r.match(this.__nlUrl))
        // rewriteRequest 只算一次（playurl 会重签 wbi，二次调用会用不同 wts 得到不同 w_rid）；结果挂实例供 send 复用
        this.__nlRw = this.__nlRule?.rewriteRequest?.(this.__nlUrl)
        return super.open(method, this.__nlRw?.url || url, ...(rest as [any, any, any]))
      }
      abort() {
        this.__nlAborted = true
        this.__nlGeneration++ // Promise 稍后返回也不得重新 open/send，避免复活已取消的旧视频请求
        return super.abort()
      }
      setRequestHeader(name: string, value: string) {
        try { this.__nlHeaders.push([name, value]) } catch { /* ignore */ }
        return super.setRequestHeader(name, value)
      }
      private __nlApplyCreds(c?: RequestCredentials) {
        if (c === 'omit') this.withCredentials = false // 跨源不带 cookie = 匿名
        else if (c) this.withCredentials = true
      }
      send(body?: any) {
        // 慢路径：规则支持异步改写、且同步没拿到 url（如 playurl 的 wbi key 未就绪）→ 推迟发送，等改写就绪。
        if (this.__nlRule?.awaitRewrite && !this.__nlRw?.url) {
          const generation = this.__nlGeneration
          const openArgs = [...this.__nlOpenArgs] as [any, any, ...any[]]
          const headers = [...this.__nlHeaders]
          const stillCurrent = () => !this.__nlAborted && this.__nlGeneration === generation
          const sendCurrent = (rw?: { url?: string; credentials?: RequestCredentials }) => {
            if (!stillCurrent()) return
            try {
              if (rw?.url) {
                const [method, _oldUrl, ...rest] = openArgs
                super.open(method, rw.url, ...(rest as [any, any, any])) // 完整保留 async/user/password
                for (const h of headers) { try { super.setRequestHeader(h[0], h[1]) } catch { /* ignore */ } }
              }
              this.__nlApplyCreds(rw?.credentials)
            } catch { /* ignore */ }
            if (!stillCurrent()) return
            try { super.send(body) } catch { /* ignore */ }
          }
          this.__nlRule.awaitRewrite(this.__nlUrl).then((rw) => {
            sendCurrent(rw)
          }, () => sendCurrent()) // 异步改写失败 → 仅当仍是当前请求时按原始 URL 发
          return // 本次 send 已托管给上面的 promise，别再往下同步发
        }
        this.__nlApplyCreds(this.__nlRw?.credentials)
        return super.send(body)
      }
      get responseText(): string {
        const rt = this.responseType
        if (rt !== '' && rt !== 'text') return super.responseText // 非文本型：交回原生（读它本就抛 InvalidStateError，语义一致），别再解析
        const raw = super.responseText
        if (this.readyState === 4 && this.__nlRule?.rewriteResponse && typeof raw === 'string') {
          try { return JSON.stringify(this.__nlRule.rewriteResponse(JSON.parse(raw), this.__nlUrl)) } catch { return raw }
        }
        return raw
      }
      get response(): any {
        const raw = super.response
        if (this.readyState === 4 && this.__nlRule?.rewriteResponse) {
          if (typeof raw === 'string') { try { return JSON.stringify(this.__nlRule.rewriteResponse(JSON.parse(raw), this.__nlUrl)) } catch { return raw } }
          if (raw && typeof raw === 'object') { try { return this.__nlRule.rewriteResponse(raw, this.__nlUrl) } catch { return raw } }
        }
        return raw
      }
    }
    window.XMLHttpRequest = X as any
  }
}
