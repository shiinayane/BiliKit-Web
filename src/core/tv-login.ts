import qrcode from 'qrcode-generator'
import { signAppQuery } from '../lib/app-sign'

/**
 * TV 端扫码登录取 access_key —— 跑在 Core 的「页面世界」（@grant none），用**普通 fetch +
 * credentials:'include'**（带登录 cookie、正常浏览器指纹）打 passport。
 * 关键：passport 允许带凭据的 CORS，且正常浏览器请求过 SEC 风控；用 GM 后台请求会被 SEC 412
 * （详见 docs 与实测）。这也是 Bilibili-Gate 的做法（它用 `request` 而非 `gmrequest`）。
 * 成功后把 access_token 交给 onSuccess（面板存进 bilikit:settings 的 feed.accessKey）。
 */
const PASSPORT = 'https://passport.bilibili.com'

async function postSigned(path: string, params: Record<string, string>): Promise<any> {
  const ts = String(Math.floor(Date.now() / 1000))
  const body = signAppQuery({ ...params, local_id: '0', ts })
  const res = await fetch(PASSPORT + path, {
    method: 'POST',
    credentials: 'include', // 带 web 登录 cookie → SEC 视为可信会话
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error('响应非 JSON（可能被风控拦截）') } // 别让 res.json() 直接抛穿
}

/* ------------------------------------------------------------------ *
 * 浮层 UI（Shadow DOM 隔离，深色卡 + B站粉，跟 BiliKit-Web 一套视觉）
 * ------------------------------------------------------------------ */
let root: HTMLElement | null = null
let qrImg: HTMLImageElement | null = null
let statusEl: HTMLElement | null = null
let running = false
let pollTimer: ReturnType<typeof setInterval> | null = null

// 仅清 DOM（openOverlay 重建时用，不动 running/timer）
function resetOverlayDom(): void {
  if (root) root.remove()
  root = qrImg = statusEl = null
}

// 完整收尾（取消/失效/失败时）：停轮询 + 解锁 running + 清 DOM，避免 running 卡 true 致无法再次登录
function closeOverlay(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  running = false
  resetOverlayDom()
}

function openOverlay(): void {
  resetOverlayDom()
  root = document.createElement('div')
  const sr = root.attachShadow({ mode: 'open' })
  sr.innerHTML = `<style>
    :host{ all:initial }
    .ov{ position:fixed; inset:0; z-index:2147483600; background:rgba(0,0,0,.55);
      display:flex; align-items:center; justify-content:center;
      font-family:-apple-system,"PingFang SC",sans-serif; -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); }
    .card{ width:300px; background:#1c1d22; color:#e3e5e7; border-radius:16px; padding:22px; text-align:center;
      box-shadow:0 16px 56px rgba(0,0,0,.5); }
    .title{ font-size:15px; font-weight:600; margin-bottom:4px } .title b{ color:#fb7299 }
    .hint{ font-size:12px; color:rgba(255,255,255,.45); margin-bottom:16px }
    .qr{ width:200px; height:200px; background:#fff; border-radius:10px; margin:0 auto; display:flex; align-items:center; justify-content:center; overflow:hidden }
    .qr img{ width:184px; height:184px; display:block }
    .status{ font-size:13px; color:rgba(255,255,255,.75); margin-top:16px; min-height:18px }
    .close{ margin-top:14px; cursor:pointer; color:rgba(255,255,255,.5); font-size:12px }
    .close:hover{ color:#fff }
    @media (prefers-color-scheme: light){
      .card{ background:#fff; color:#18191c; box-shadow:0 16px 56px rgba(0,0,0,.22) }
      .title b{ color:#d6336c } .hint{ color:rgba(0,0,0,.45) } .status{ color:rgba(0,0,0,.7) }
      .close{ color:rgba(0,0,0,.45) } .close:hover{ color:#000 }
    }
  </style>
  <div class="ov"><div class="card">
    <div class="title"><b>BiliKit-Web</b> · 登录 App 推荐</div>
    <div class="hint">用手机哔哩哔哩 App 扫码</div>
    <div class="qr"><img alt=""></div>
    <div class="status">正在获取二维码…</div>
    <div class="close">取消</div>
  </div></div>`
  qrImg = sr.querySelector('img')
  statusEl = sr.querySelector('.status')
  sr.querySelector('.close')!.addEventListener('click', closeOverlay)
  sr.querySelector('.ov')!.addEventListener('click', (e) => { if ((e.target as HTMLElement).classList.contains('ov')) closeOverlay() })
  document.body.appendChild(root)
}

function setStatus(t: string): void { if (statusEl) statusEl.textContent = t }
function renderQR(url: string): void {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  if (qrImg) qrImg.src = qr.createDataURL(6, 8)
  setStatus('等待扫码…')
}

/** 启动扫码登录。成功时用拿到的 access_key 调 onSuccess。 */
export function startTvLogin(onSuccess: (accessKey: string) => void): void {
  if (running || window.top !== window.self) return
  running = true
  openOverlay()
  ;(async () => {
    try {
      const auth = await postSigned('/x/passport-tv-login/qrcode/auth_code', {})
      if (!root) { running = false; return } // 期间用户已取消
      if (auth.code !== 0 || !auth.data) { setStatus(`获取二维码失败：${auth.code} ${auth.message || ''}`); running = false; return }
      const { url, auth_code } = auth.data
      renderQR(url)
      const started = Date.now()
      let polling = false // 防重入：上一次轮询未回不发新的（慢网叠请求）
      let failStreak = 0 // 连续轮询失败计数，过多才中止（容忍偶发）
      pollTimer = setInterval(async () => {
        if (!root) { closeOverlay(); return } // 用户关了
        if (Date.now() - started > 180000) { setStatus('二维码已过期，请重新登录'); closeOverlay(); return }
        if (polling) return
        polling = true
        try {
          const poll = await postSigned('/x/passport-tv-login/qrcode/poll', { auth_code })
          failStreak = 0
          if (poll.code === 0 && poll.data && poll.data.access_token) {
            const t = pollTimer; pollTimer = null; if (t) clearInterval(t) // 停轮询，但保留浮层到刷新
            running = false
            onSuccess(poll.data.access_token)
            setStatus('登录成功，即将刷新…')
            setTimeout(() => { resetOverlayDom(); location.reload() }, 1000)
          } else if (poll.code === 86038) { setStatus('二维码已失效，请重新登录'); closeOverlay() }
          else if (poll.code === 86090) { setStatus('已扫码，请在手机上确认') }
          else if (poll.code === 86039) { /* 未扫码，继续等 */ }
          else { setStatus(`登录失败：${poll.code} ${poll.message || ''}`); closeOverlay() } // 未知/错误码不再空转到超时
        } catch (_) {
          if (++failStreak >= 5) { setStatus('网络或风控异常，请稍后重试'); closeOverlay() }
        } finally {
          polling = false
        }
      }, 2000)
    } catch (e) {
      setStatus('登录出错：' + (e as Error).message)
      running = false
    }
  })()
}
