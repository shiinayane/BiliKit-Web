import type { BiliKitModule, Cfg } from '../../core/module'
import { setModuleEnabled, get, set } from '../../core/settings'
import { installNetHook, type NetRule } from './net-hook'
import { signQuery, warmKeys, ensureKeys } from './wbi-core'
import { playurlParams } from './playurl'
import {
  initialAuthAction,
  loginCookieFingerprint,
  rememberVerifiedLogin,
  verifyLogin,
} from './auth-state'

/**
 * 免登录：未登录也能看评论 / 他人动态 / 1080p 视频——装它即可卸载 beefreely 等第三方脚本，
 * 从根上消掉「两个脚本抢 fetch/XHR」的竞态（issue #2）。做法逆向自 beefreely（详见 docs/RESEARCH-no-login.md）：
 *  - 伪造 DedeUserID cookie 让页面「以为」已登录；
 *  - nav 响应合并成已登录（保留 wbi_img）→ 登录态 UI + 动态可见；
 *  - reply 请求走匿名(credentials:'omit') → 放行公开评论；
 *  - playurl 塞 qn=80+try_look=1 重签 wbi + 置空预埋 __playinfo__ → 1080p；player/wbi/v2 改字段让 UI 认账。
 *
 * 侵入性 → 仅「未登录」时生效：登录标记交给 nav 确认，真登录整体不启用，绝不干扰真实账号。
 * 纯只读观看：任何要真鉴权的动作（发评论/点赞/投币/历史同步）都会失败；1080p 上限为 try_look（大会员专享清晰度拿不到）。
 */
// 需要「真登录」的个人数据页：伪造登录会让它们拿假身份取不到数据、前后端状态打架 → 反复重刷。
// 这些页免登录一律不碰（收藏/历史/稍后看/清单/消息/账号/会员中心等）。
const AUTH_HOSTS = ['message.bilibili.com', 'account.bilibili.com', 'member.bilibili.com', 'pay.bilibili.com', 'big.bilibili.com']
const AUTH_PATHS = ['/history', '/watchlater', '/favlist', '/medialist', '/account', '/pincenter']
function needsRealLogin(): boolean {
  if (AUTH_HOSTS.includes(location.hostname)) return true
  return AUTH_PATHS.some((p) => location.pathname.includes(p))
}
// 清掉本模块之前在别处（视频/首页）种下的假 DedeUserID（此时必无真登录 ckMd5，故任何 DedeUserID 都是假的）
function clearFakeUid(): void {
  try { if (/DedeUserID=/.test(document.cookie)) document.cookie = 'DedeUserID=; path=/; domain=.bilibili.com; max-age=0' } catch { /* ignore */ }
}

function getSessionStorage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

function init(_cfg: Cfg): void {
  if ((window as any).__BILIKIT_NO_LOGIN__) return
  // 顶层窗口总是生效；iframe 仅限我们自己的抽屉（bk-drawer 标记）——好让 Feed 抽屉里看视频也享免登录 1080p/评论。
  // 假 DedeUserID cookie 是 domain=.bilibili.com、顶层已种，抽屉 iframe 同域天然共享，无需重种。
  if (window.top !== window.self && !location.hash.includes('bk-drawer')) return
  if (location.hostname === 'passport.bilibili.com') return // 登录页不碰
  // Cookie 只说明浏览器里留过登录标记，不等于服务端仍承认该会话（issue #5：普通窗口残留失效
  // DedeUserID__ckMd5，隐私窗口/清站点数据正常）。无标记时继续走零开销访客快路径；有标记时先查
  // sessionStorage 的服务端确认结果。真登录让路；已确认失效则忽略残留标记，立即进入访客模式。
  const fingerprint = loginCookieFingerprint(document.cookie)
  const authStorage = fingerprint ? getSessionStorage() : null
  // 有疑似真登录标记却无法安全缓存验证结果时保守让路：否则无法保证失效恢复只刷新一次。
  const authAction = fingerprint
    ? (authStorage ? initialAuthAction(document.cookie, authStorage) : 'skip')
    : 'activate-guest'
  if (authAction === 'skip') return
  if (authAction === 'verify') {
    // 抽屉 iframe 不重复探测；顶层会确认并在失效时刷新，随后重建的 iframe 会直接读到缓存结论。
    if (window.top !== window.self || (window as any).__BILIKIT_NO_LOGIN_AUTH_CHECK__) return
    ;(window as any).__BILIKIT_NO_LOGIN_AUTH_CHECK__ = true
    const pureFetch = window.fetch?.bind(window)
    if (!fingerprint || !authStorage || !pureFetch) return
    void verifyLogin(pureFetch).then((status) => {
      // 探测期间用户可能刚完成登录/退出；cookie 已变化时丢弃旧请求结论。
      if (loginCookieFingerprint(document.cookie) !== fingerprint) return
      if (rememberVerifiedLogin(authStorage, fingerprint, status) !== 'reload') return
      // 当前 Document 已错过 document-start 的 playinfo 拦截时机；可靠缓存后仅刷新一次，下一次启动
      // 会直接进入访客模式。sessionStorage 写失败不会走到这里，因此不会形成刷新循环。
      try { location.reload() } catch { /* ignore */ }
    })
    return
  }
  // 个人数据页：不伪造，并清掉别处种下的假 cookie，让页面按未登录干净处理（跳登录/空列表），不重刷
  if (needsRealLogin()) { clearFakeUid(); return }
  ;(window as any).__BILIKIT_NO_LOGIN__ = true

  // 免登录默认开、仅未登录时激活（真登录已由上面的 nav 确认分支 return）。首次真正激活时，底部弹**一次**
  // 可关闭的知情提示——把「静默伪造登录态」变成「明确告知、想关一键关」。放在这（激活确认后）而非模块外层，
  // 保证已登录用户永远看不到；只在顶层窗口弹（抽屉 iframe 不重复）。
  showGuestNotice()
  // 免登录伪造了登录态 → 顶栏真「登录」入口被假头像顶掉，想真登录无门；而假登录下点「退出登录」又没意义。
  // 把用户最自然会点的「退出登录」重定向到登录页（清假 cookie 后跳转，不关模块——只是要登录一次）。
  installLogoutIntercept()

  // 1) 伪造 DedeUserID cookie → 页面按登录态渲染（评论区/动态/播放器）
  if (!/DedeUserID=/.test(document.cookie)) {
    try { document.cookie = `DedeUserID=${Math.floor(Math.random() * 2 ** 50)}; path=/; domain=.bilibili.com` } catch { /* ignore */ }
  }

  // 1.5) 收拾伪造登录的副作用：个别带假 cookie 的请求被服务端判 -101 → 打开视频瞬间闪一个红色
  //      「账号未登录」toast（Vant 的 .van-message-error，一闪即逝）。CSS 藏掉，眼不见。
  //      仅在免登录开启时注入，不影响真登录/未启用免登录的用户的正常错误提示。
  try {
    const st = document.createElement('style')
    st.textContent = '.van-message.van-message-error{display:none!important}'
    ;(document.head || document.documentElement).appendChild(st)
  } catch { /* ignore */ }

  // 2) 置空页面预埋的低清 __playinfo__（吞掉 SSR 赋值）→ 逼播放器重新请求 playurl，好让下面升到 1080p。
  //    注册在 cdn-pick 之后 → 本定义覆盖 cdn-pick 的 __playinfo__ setter（其 SSR 首帧换 host 那条随之失效）；
  //    但播放器**重新请求**的 playurl 仍会过 cdn-pick 的 fetch/XHR hook 换 host，故 CDN 优选对真正的取流不丢。
  try {
    Object.defineProperty(window, '__playinfo__', { configurable: true, get: () => null, set: () => { /* 丢弃低清 SSR 数据 */ } })
  } catch { /* ignore */ }
  // 2.5) 新版播放器读的是 playurlSSRData 而非 __playinfo__：抢先声明 const 全局词法绑定 →
  //      页面后续的 SSR 内联赋值报错被吞、播放器裸引用只能拿到我们的空对象 → 同样逼它重新请求 playurl。
  //      （照抄 beefreely core/config.ts 的 www action；少了它，新版播放器首帧仍会用 SSR 低清流。）
  try {
    const sc = document.createElement('script')
    sc.textContent = 'const playurlSSRData = {}'
    ;(document.head || document.documentElement).appendChild(sc)
    sc.remove()
  } catch { /* ignore */ }

  // 捕获未被本模块包裹的 fetch，供 wbi 取 key 兜底（打 nav 时不经自身 rewrite）
  const pureFetch = window.fetch.bind(window)
  warmKeys(pureFetch)

  // 假的「已登录」用户字段：合并到真实 nav.data 上，保留 wbi_img 等原字段不动
  const MID = Math.floor(Math.random() * 1e15)
  const MOCK_USER = {
    isLogin: true,
    is_login: true,
    mid: MID,
    uname: 'bilibili',
    face: 'https://i0.hdslb.com/bfs/face/member/noface.jpg',
    email_verified: 1,
    mobile_verified: 1,
    money: 0,
    moral: 70,
    level_info: { current_level: 6, current_min: 28800, current_exp: 29050, next_exp: '--' },
    official: { role: 0, title: '', desc: '', type: -1 },
    officialVerify: { type: -1, desc: '' },
    vipStatus: 0,
    vipType: 0,
  }

  // space/v2/myinfo 的假「本人资料」：空间页登录后必打此接口，假 cookie 下必返 -101，
  // 空间前端见「cookie 已登录 + myinfo 未登录」即判会话失效而 location.reload → 死循环。
  // 形状整体照抄 beefreely（space/model/constants.ts，对空间前端 known-good），mid 与 MOCK_USER 同一 MID——
  // 「是否本人空间」按 mid 对比，假 mid ≠ 页面 UP mid → 一律按访客视角渲染，正好是我们要的只读浏览。
  const MOCK_MYINFO = {
    profile: {
      mid: MID, name: 'bilibili', sex: '保密', face: 'https://i0.hdslb.com/bfs/face/member/noface.jpg', sign: '',
      rank: 10000, level: 6, jointime: 0, moral: 70, silence: 0, email_status: 0, tel_status: 1, identification: 0,
      vip: { type: 0, status: 0, due_date: 0, vip_pay_type: 0, theme_type: 0,
        label: { path: '', text: '', label_theme: '', text_color: '', bg_style: 0, bg_color: '', border_color: '', use_img_label: true, img_label_uri_hans: '', img_label_uri_hant: '', img_label_uri_hans_static: '', img_label_uri_hant_static: '', label_id: 0, label_goto: null },
        avatar_subscript: 0, nickname_color: '', role: 0, avatar_subscript_url: '', tv_vip_status: 0, tv_vip_pay_type: 0, tv_due_date: 0,
        avatar_icon: { icon_resource: {} }, ott_info: { vip_type: 0, pay_type: 0, pay_channel_id: '', status: 0, overdue_time: 0 }, super_vip: { is_super_vip: false } },
      pendant: { pid: 0, name: '', image: '', expire: 0, image_enhance: '', image_enhance_frame: '', n_pid: 0 },
      nameplate: { nid: 0, name: '', image: '', image_small: '', level: '', condition: '' },
      official: { role: 0, title: '', desc: '', type: -1 },
      birthday: 315504000, is_tourist: 0, is_fake_account: 0, pin_prompting: 0, is_deleted: 0, in_reg_audit: 0, is_rip_user: false,
      profession: { id: 0, name: '', show_name: '', is_show: 0, category_one: '', realname: '', title: '', department: '', certificate_no: '', certificate_show: false },
      face_nft: 0, face_nft_new: 0, is_senior_member: 0,
      honours: { mid: MID, colour: { dark: '#CE8620', normal: '#F0900B' }, tags: null, is_latest_100honour: 0 },
      digital_id: '', digital_type: -2,
      attestation: { type: 0, common_info: { title: '', prefix: '', prefix_title: '' }, splice_info: { title: '' }, icon: '', desc: '' },
      expert_info: { title: '', state: 0, type: 0, desc: '' }, name_render: null, country_code: '86', handle: '',
    },
    level_exp: { current_level: 6, current_min: 28800, current_exp: 29050, next_exp: '--' },
    coins: 0, following: 0, follower: 0,
  }

  const rules: NetRule[] = [
    // space/v2/myinfo：伪造成功响应压掉空间页「会话失效 → 自刷」路径（真登录成功不动）
    {
      match: (u) => u.includes('/x/space/v2/myinfo'),
      rewriteResponse: (j) => {
        try { if (j?.code === 0 && j?.data?.profile) return j } catch { /* ignore */ }
        return { code: 0, message: '0', ttl: 1, data: MOCK_MYINFO }
      },
    },
    // nav：合并成「已登录」，保留 wbi_img 等原字段（→ 登录态 UI + 动态可见）
    {
      match: (u) => u.includes('/x/web-interface/nav'),
      rewriteResponse: (j) => {
        try {
          if (j?.data?.isLogin) return j // 真已登录不动
          j.code = 0
          j.message = '0'
          j.data = Object.assign({}, j.data, MOCK_USER)
        } catch { /* ignore */ }
        return j
      },
    },
    // reply：匿名请求（假 cookie 会被拒，去掉反而正常返公开评论）→ 视频/动态下方评论
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main') || u.includes('/x/v2/reply/reply'),
      rewriteRequest: () => ({ credentials: 'omit' }),
    },
    // player/wbi/v2：改 login_mid / 等级 / 字幕字段 → 播放器 UI 认账（清晰度、字幕可选）
    {
      match: (u) => u.includes('/x/player/wbi/v2'),
      rewriteResponse: (j) => {
        try {
          const d = j?.data
          if (d) {
            d.login_mid = MID
            d.need_login_subtitle = false
            if (d.level_info) d.level_info.current_level = 6
          }
        } catch { /* ignore */ }
        return j
      },
    },
    // relation：与 UP 的关注关系——假 cookie 下真接口返 -101 → 关注按钮/粉丝数报错、
    // 视频页红 toast 的源头之一。mock 成「无关注关系」（照抄 beefreely useRelation）。
    // 注意 match 写全 'web-interface/relation?'：别误吞 archive/relation（下一条单独管）。
    {
      match: (u) => u.includes('/x/web-interface/relation?'),
      rewriteResponse: (j) => {
        try { if (j?.code === 0 && j?.data) return j } catch { /* ignore */ }
        return { code: 0, message: '0', ttl: 1, data: {
          relation: { mid: 0, attribute: 0, mtime: 0, tag: null, special: 0 },
          be_relation: { mid: 0, attribute: 0, mtime: 0, tag: null, special: 0 },
        } }
      },
    },
    // archive/relation：与本视频的互动状态（点赞/投币/收藏）——同样返 -101 触发未登录提示。
    // mock 成「均未互动」（照抄 beefreely useArchiveRelation）。
    {
      match: (u) => u.includes('/x/web-interface/archive/relation'),
      rewriteResponse: (j) => {
        try { if (j?.code === 0 && j?.data) return j } catch { /* ignore */ }
        return { code: 0, message: '0', ttl: 1, data: {
          attention: false, favorite: false, season_fav: false, like: false, dislike: false, coin: 0,
        } }
      },
    },
    // 搜索页热搜接口拼接损坏（B 站自身 bug，只在未登录时出现）：api.bilibili.comx/... 少了个 /
    // → 404、热搜/搜索结果拿不到。补上斜杠（照抄 beefreely useSearch）。
    {
      match: (u) => u.includes('/api.bilibili.comx/web-interface/search'),
      rewriteRequest: (u) => ({ url: u.replace(/\.com(?!\/)/, '.com/') }),
    },
    // 番剧/PGC（ogv/player/playview）：把 user_status.is_login 掰成 true → 播放器不再弹
    // 「登录后观看」、清晰度不锁最低。PGC 无需重签 playurl，is_login 即全部机制（beefreely 同）。
    {
      match: (u) => u.includes('/ogv/player/playview'),
      rewriteResponse: (j) => {
        try { if (j?.data?.user_status) j.data.user_status.is_login = true } catch { /* ignore */ }
        return j
      },
    },
    // playurl：塞 qn=80(1080p) + try_look=1(试看)、去掉旧签名重签 wbi → 1080p 取流。
    // iPad/移动 Safari 触发 B 站触屏判定 → 播放器发 platform=html5(MP4)，服务端对 html5 的免登录
    // 试看只给到 480p，qn=80 也被打回。故强行掰回桌面 DASH 路径：platform=pc + fnval=4048(全 DASH)
    // + fourk=1，让服务端按桌面策略放行 1080p 试看（桌面本就这套，零风险；iPad 靠 MSE 放 DASH）。
    {
      match: (u) => u.includes('/x/player/wbi/playurl'),
      // 快路径：key 已缓存 → 同步签名，零延迟
      rewriteRequest: (u) => {
        try {
          const { base, params } = playurlParams(u) // 纯参数改写在 ./playurl
          const signed = signQuery(params)
          if (!signed) return // 拿不到 wbi key → 交给下面 awaitRewrite 等 key
          return { url: `${base}?${signed}` }
        } catch { return }
      },
      // 慢路径：无痕会话**首个视频** key 还没暖好 → 等 nav 拉到 key（≤1.5s）再签名发出，
      // 否则首帧只能 480p、要刷新一次才 1080p（issue #? 追加反馈的根因）。等到即 1080p，超时则原样发。
      awaitRewrite: async (u) => {
        try {
          if (!(await ensureKeys(pureFetch, 1500))) return
          const { base, params } = playurlParams(u)
          const signed = signQuery(params)
          return signed ? { url: `${base}?${signed}` } : undefined
        } catch { return }
      },
    },
  ]
  installNetHook(rules)
}

/* ---------------- 免登录激活的一次性知情提示 ---------------- */
// 「弹过一次」标志走**设置系统**（get/set → 镜像到 .bilibili.com cookie），**跨子域共享**：在 www 弹过后，
// search/space 等子域不再重复弹（localStorage 按子域隔离，早先存 localStorage 会每个子域各弹一次——已修）。
// 普通模式一次永逸；无痕的 cookie 每会话清空 → 每个无痕会话（跨子域）只弹一次。
const NOTICE_KEY = 'no-login.notified'
const NOTICE_CSS = `
.bk-nl-toast{ position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(10px);
  z-index:2147483000; display:flex; align-items:center; gap:10px; max-width:min(94vw,540px);
  padding:11px 12px 11px 15px; border-radius:12px; background:rgba(22,23,28,.94); color:#e3e5e7;
  border:1px solid rgba(255,255,255,.1); box-shadow:0 8px 32px rgba(0,0,0,.42);
  -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px);
  font-family:-apple-system,"PingFang SC",sans-serif; font-size:13px; line-height:1.5;
  opacity:0; transition:opacity .28s ease, transform .28s ease; }
.bk-nl-toast.on{ opacity:1; transform:translateX(-50%) translateY(0); }
.bk-nl-toast .bk-nl-txt{ flex:1; min-width:0; }
.bk-nl-toast .bk-nl-txt b{ color:#fff; font-weight:600; }
.bk-nl-toast .bk-nl-sub{ color:rgba(255,255,255,.5); font-size:11px; margin-top:2px; }
.bk-nl-toast .bk-nl-btn{ flex:0 0 auto; height:30px; padding:0 13px; border-radius:8px; cursor:pointer; white-space:nowrap;
  font-size:12.5px; font-weight:500; font-family:inherit; transition:background .15s ease, border-color .15s ease; }
.bk-nl-toast .bk-nl-off{ border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06); color:#e3e5e7; }
.bk-nl-toast .bk-nl-off:hover{ background:rgba(255,255,255,.13); }
.bk-nl-toast .bk-nl-login{ border:1px solid transparent; background:#fb7299; color:#fff; }
.bk-nl-toast .bk-nl-login:hover{ background:#fb8bab; }
.bk-nl-toast .bk-nl-x{ flex:0 0 auto; width:22px; height:22px; padding:0; border:none; background:none;
  color:rgba(255,255,255,.4); font-size:17px; line-height:1; cursor:pointer; transition:color .15s ease; }
.bk-nl-toast .bk-nl-x:hover{ color:rgba(255,255,255,.75); }`

// 「我要登录」：清假 cookie 后跳登录页（gourl 登录后回跳当前页）。**不关免登录**——只是要登录一次；
// 真登录后 ckMd5 在，模块自动让路。顶层导航避免在抽屉 iframe 里被 passport 的 X-Frame 拦。
function exitToLogin(): void {
  clearFakeUid() // 真登录会写入真 DedeUserID 覆盖，这里先清掉假的让登录页/回跳干净
  const login = 'https://passport.bilibili.com/login?gourl=' + encodeURIComponent(location.href)
  try { (window.top || window).location.href = login } catch { location.href = login }
}
// 「关闭功能」：显式记住关闭免登录 + 清假 cookie + 刷新，回到干净未登录态并留在当前页。
function disableNoLogin(): void {
  try { setModuleEnabled('no-login', false) } catch { /* ignore */ }
  clearFakeUid()
  try { location.reload() } catch { /* ignore */ }
}

function showGuestNotice(): void {
  if (window.top !== window.self) return // 只在顶层弹（抽屉 iframe 不重复）
  if (get(NOTICE_KEY, false)) return // 弹过就不再弹（跨子域共享，见 NOTICE_KEY 注释）
  const run = (): void => {
    if (!document.body) return
    set(NOTICE_KEY, true) // 记「已弹」→ 镜像到 .bilibili.com cookie，其它子域读得到（无痕写失败也无妨，最多多弹一次）
    try {
      const style = document.createElement('style')
      style.textContent = NOTICE_CSS
      ;(document.head || document.documentElement).appendChild(style)
      const box = document.createElement('div')
      box.className = 'bk-nl-toast'
      box.innerHTML =
        '<div class="bk-nl-txt"><b>已开启免登录</b>——未登录也能看评论 / 1080p。' +
        '<div class="bk-nl-sub">想用自己的账号点「我要登录」；不需要此功能点「关闭功能」。</div></div>' +
        '<button class="bk-nl-btn bk-nl-off" type="button">关闭功能</button>' +
        '<button class="bk-nl-btn bk-nl-login" type="button">我要登录</button>' +
        '<button class="bk-nl-x" type="button" aria-label="忽略">×</button>'
      document.body.appendChild(box)
      requestAnimationFrame(() => box.classList.add('on'))
      let fadeTimer: ReturnType<typeof setTimeout> | null = setTimeout(dismiss, 8000) // 无操作 8s 自动淡出（默认保持开启）
      function dismiss(): void {
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null }
        box.classList.remove('on')
        setTimeout(() => { try { box.remove() } catch { /* ignore */ } }, 320)
      }
      const stopFade = (): void => { if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null } }
      box.querySelector('.bk-nl-x')?.addEventListener('click', dismiss)
      box.querySelector('.bk-nl-off')?.addEventListener('click', () => { stopFade(); disableNoLogin() })
      box.querySelector('.bk-nl-login')?.addEventListener('click', () => { stopFade(); exitToLogin() })
    } catch { /* ignore */ }
  }
  if (document.body) run()
  else document.addEventListener('DOMContentLoaded', run, { once: true })
}

/* ---------------- 「退出登录」→ 直奔登录页 ---------------- */
// 假登录态下，顶栏用户菜单里的「退出登录」点了没意义（本就没真会话）；而想真登录又找不到入口（登录按钮被假头像顶掉）。
// 拦住这个点击 → 清假 cookie + 跳登录页（gourl 回跳当前页）。**不关免登录**：登录后 ckMd5 在，模块自动让路；
// 若没登录成功回到未登录，免登录照常自动生效——用户只是要登录一次，不该被顺手废掉功能。
function isLogoutClick(start: Element | null): boolean {
  let el: Element | null = start
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    const cls = typeof el.className === 'string' ? el.className : ''
    if (/(^|[\s_-])logout/i.test(cls)) return true // 默认顶栏登出项类名 .logout-item（见 Bilibili-Gate cookie.ts）
    const href = el.getAttribute?.('href')
    if (href && /login\/exit/i.test(href)) return true // 老版为 <a href=".../login/exit/v2">
    const txt = (el.textContent || '').trim()
    if (txt === '退出登录') return true // 兜底：类名/结构变了也能认（精确短文本，不误伤大容器）
  }
  return false
}
function installLogoutIntercept(): void {
  if ((window as any).__BILIKIT_NL_LOGOUT__) return // 幂等
  ;(window as any).__BILIKIT_NL_LOGOUT__ = true
  // 捕获阶段：抢在 B 站自身的冒泡 @click（登出请求/跳转）之前拦下
  document.addEventListener('click', (e) => {
    try {
      if (!isLogoutClick(e.target as Element)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      // 点「退出登录」的真实意图是「我要真登录」→ 跳登录页（不关免登录，同弹窗的「我要登录」）
      exitToLogin()
    } catch { /* ignore */ }
  }, true)
}

export const noLogin: BiliKitModule = {
  id: 'no-login',
  name: '免登录',
  description: '未登录也能看评论 / 他人动态 / 1080p（装它即可替代 beefreely，避免脚本冲突）',
  note:
    '开启后未登录也能：看视频/动态下方<b>评论</b>、看他人<b>动态</b>、看 <b>1080p</b> 视频。装了它就能卸载 beefreely 等免登录脚本，避免多个脚本抢改请求导致的时好时坏。<br>' +
    '<b>取舍（务必知悉）</b>：' +
    '① 纯<b>只读</b>——页面「以为」你已登录（显示假账号），但发评论/点赞/投币/收藏/历史同步等需真鉴权的操作都会失败；' +
    '② <b>看不到评论 IP 属地</b>——评论走匿名请求，B 站服务端只对真登录返回属地字段，免登录下拿不到（「评论信息」里的性别仍可显示）；' +
    '③ 1080p 上限为官方<b>试看</b>，4K/HDR/大会员专享清晰度仍拿不到；' +
    '④ 仅<b>未登录</b>时生效，检测到已登录会自动让路、不干扰真账号。<br>' +
    '若浏览器残留了服务端已失效的登录状态，会自动确认并<b>刷新一次</b>后恢复免登录，不会清除你的 Cookie。<br>' +
    '<b>默认开启</b>：只在未登录时激活（已登录零影响），首次激活会在底部弹一次可关闭的提示。这样无痕/未登录浏览打开即 1080p，无需每次手动开。<br>' +
    '<b>想真正登录</b>：直接点顶栏用户菜单里的「退出登录」即可——会跳到登录页，登录后自动回到当前页面；免登录本身<b>不会被关掉</b>，下次未登录时照常自动生效。',
  category: '增强',
  // 默认开：仅未登录时激活（真登录由 nav 确认后 return、零影响），首次激活弹一次性可关提示告知。
  // 目的：无痕模式存不住任何页面侧开关（localStorage/cookie 关窗即清、@grant none 无法用 GM 存储跨会话），
  // 唯一能让「无痕未登录时默认免登录」成立的就是把默认值设对；用一次性披露弹框换取透明、避免静默吓到人。
  defaultEnabled: true,
  runAt: 'start',
  init,
}
