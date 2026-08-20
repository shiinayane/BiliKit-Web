import { get, set, isModuleEnabled, setModuleEnabled, getField, setField } from './settings'
import { getModules, type BiliKitModule, type SettingField } from './module'
import { startTvLogin } from './tv-login'
import { VERSION } from './version'
import {
  DEFAULT_NEW_TAB_HISTORY_FLATTEN,
  DEFAULT_OPEN_MODE,
  NEW_TAB_HISTORY_FLATTEN_KEY,
  isSafariUserAgent,
} from './new-tab'

/**
 * 设置面板：右下悬浮齿轮（有 Feed 则并入其 FAB）→ 居中模态，Shadow DOM 隔离。
 * 主从布局（scales to many modules）：左栏按 category 分组，每行 = 模块名 + 「有可调项」粉点 + 启用开关；
 * 右栏只渲染当前选中模块的配置（无配置则空态）。开关在左栏 → 只有开关的模块也不用进右栏、不空亏。
 * 深浅色跟随系统。只在顶层窗口挂。
 */
const PANEL_ID = 'bilikit-panel-root'
const FEED_ID = '__feed__'
const OPEN_ID = '__open__' // 「打开方式」独立成项，与 Feed 登录分开
const PREVIEW_ID = '__preview__' // 「封面预览」方式（真视频 / 雪碧图 / 关闭）
const ABOUT_ID = '__about__' // 「关于」：版本号 + GitHub / 反馈 / GreasyFork 链接
const FEED_CAT = '推荐'
const ABOUT_CAT = '关于'
let selected = ''

let navEl: HTMLElement | null = null
let detailEl: HTMLElement | null = null
let footEl: HTMLElement | null = null

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "PingFang SC", sans-serif; }

.gear {
  position: fixed; right: 24px; bottom: 32px; z-index: 99990; /* 与 Feed 右下悬浮按钮同位对齐；低于抽屉遮罩(100000)：抽屉一开即被盖住 */
  width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,.1); background: rgba(22,23,28,.9); color: #fff;
  box-shadow: 0 3px 14px rgba(0,0,0,.3); opacity: .92;
  transition: opacity .18s ease, transform .16s ease, box-shadow .16s ease;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.gear:hover { opacity: 1; transform: translateY(-2px); box-shadow: 0 5px 16px rgba(0,0,0,.2); }
.gear:hover svg { transform: rotate(30deg); }
.gear:active { transform: scale(.94); }
.gear svg { width: 20px; height: 20px; display: block; transition: transform .16s ease; }
.gear.hidden { display: none; } /* Feed 在场时并入其 FAB，隐藏这颗独立齿轮 */

.overlay {
  position: fixed; inset: 0; z-index: 2147483501; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s;
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
}
.overlay.open { opacity: 1; visibility: visible; transition: opacity .2s ease; }

.card {
  width: min(660px, calc(100vw - 32px)); height: 560px; max-height: 90vh;
  display: flex; flex-direction: column;
  background: #1c1d22; color: #e3e5e7; border-radius: 18px;
  box-shadow: 0 16px 56px rgba(0,0,0,.5); overflow: hidden;
  transform: translateY(10px) scale(.98); transition: transform .2s ease;
}
.overlay.open .card { transform: none; }

.head { display: flex; align-items: baseline; gap: 10px; padding: 18px 22px 14px; border-bottom: 1px solid rgba(255,255,255,.06); flex: 0 0 auto; }
.head .title { font-size: 17px; font-weight: 600; letter-spacing: .2px; }
.head .brand { color: #fb7299; }
.head .close { margin-left: auto; cursor: pointer; width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: rgba(255,255,255,.7); font-size: 18px; line-height: 1; display: flex; align-items: center; justify-content: center; transition: color .16s ease, border-color .16s ease, transform .12s ease; }
.head .close:hover { color: #fb7299; border-color: #fb7299; }
.head .close:active { transform: scale(.92); }

.main { flex: 1; display: flex; min-height: 0; }
.nav { width: 228px; flex: 0 0 auto; border-right: 1px solid rgba(255,255,255,.06); overflow: auto; padding: 12px 10px; }
.nav-cat { font-size: 12px; letter-spacing: .3px; color: rgba(255,255,255,.35); padding: 12px 8px 5px; }
.nav-cat:first-child { padding-top: 4px; }
.nav-item { display: flex; align-items: center; gap: 8px; padding: 9px 9px; border-radius: 9px; cursor: pointer; }
.nav-item:hover { background: rgba(255,255,255,.05); }
.nav-item.sel { background: rgba(251,114,153,.16); }
.nm-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; }
.nav-item .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: rgba(255,255,255,.85); }
.nav-item.sel .nm { color: #fb7299; font-weight: 500; }
.gear-ico { flex: 0 0 auto; width: 13px; height: 13px; color: rgba(255,255,255,.38); display: flex; }
.gear-ico svg { width: 13px; height: 13px; display: block; }
.nav-item:hover .gear-ico, .nav-item.sel .gear-ico { color: #fb7299; }

.detail { flex: 1; min-width: 0; overflow: auto; padding: 26px; display: flex; flex-direction: column; }
.detail-title { font-size: 19px; font-weight: 600; }
.detail-desc { font-size: 14px; color: rgba(255,255,255,.5); margin-top: 7px; line-height: 1.55; }
.fields { margin-top: 22px; display: flex; flex-direction: column; gap: 18px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field.row { flex-direction: row; align-items: center; justify-content: space-between; gap: 14px; }
.field.row .flabel { flex: 1; }
/* 开关行：标签+开关一行（space-between），hint 由 .field 的列布局落到下一行，避免三者挤成一排 */
.field .toggle-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.field .toggle-head .flabel { flex: 1; }
.field .flabel { font-size: 14px; color: rgba(255,255,255,.8); line-height: 1.4; }
.field .hint { font-size: 13px; color: rgba(255,255,255,.4); line-height: 1.45; }
.field input[type=text], .field textarea, .field select {
  width: 100%; background: rgba(255,255,255,.06); color: #e3e5e7;
  border: 1px solid rgba(255,255,255,.14); border-radius: 9px; padding: 9px 12px;
  font-size: 14px; font-family: inherit; outline: none;
}
.field input[type=text]:focus, .field textarea:focus, .field select:focus { border-color: #fb7299; }
.field textarea { min-height: 72px; resize: vertical; line-height: 1.5; }

.empty { margin: auto; text-align: center; color: rgba(255,255,255,.3); font-size: 14px; padding: 24px; }
.empty .ei { font-size: 30px; opacity: .5; margin-bottom: 8px; }
.empty .es { margin-top: 3px; font-size: 13px; }

.sw { position: relative; flex: 0 0 auto; width: 44px; height: 24px; }
.sw.sm { width: 34px; height: 19px; }
.sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 1; }
.sw .track { position: absolute; inset: 0; border-radius: 24px; background: rgba(255,255,255,.16); transition: background .16s ease; }
.sw .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform .16s ease; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.sw.sm .track::after { width: 15px; height: 15px; }
.sw input:checked + .track { background: #fb7299; }
.sw input:checked + .track::after { transform: translateX(20px); }
.sw.sm input:checked + .track::after { transform: translateX(15px); }

/* 提示块：淡底圆角 + 图标，取代浮着的灰字。info 常规 / warn 品牌色调 */
.callout { display: flex; gap: 9px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.055); font-size: 12.5px; line-height: 1.5; color: rgba(255,255,255,.62); }
.callout .ci { flex: 0 0 auto; margin-top: 1px; opacity: .85; }
.callout .ci svg { display: block; width: 14px; height: 14px; }
.callout a { color: #fb7299; text-decoration: none; font-weight: 500; }
.callout a:hover { text-decoration: underline; }
.callout.warn { background: rgba(251,114,153,.13); color: rgba(255,255,255,.82); }
.callout.warn .ci { color: #fb7299; opacity: 1; }
/* 状态徽章：带色点的 pill */
.status { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; padding: 5px 12px; border-radius: 20px; background: rgba(255,255,255,.07); color: rgba(255,255,255,.6); }
.status .dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,.35); flex: 0 0 auto; }
.status.on { background: rgba(251,114,153,.15); color: #fb7299; }
.status.on .dot { background: #fb7299; box-shadow: 0 0 0 3px rgba(251,114,153,.2); }
.feed-btn { align-self: flex-start; cursor: pointer; color: #fff; background: #fb7299; border: none; border-radius: 9px; padding: 9px 18px; font-size: 14px; font-family: inherit; font-weight: 500; }
.feed-btn.ghost { background: transparent; border: 1px solid rgba(255,255,255,.2); color: #e3e5e7; }
.feed-btn:hover { filter: brightness(1.08); }

.foot { padding: 12px 22px 15px; font-size: 12px; color: rgba(255,255,255,.4); display: flex; align-items: center; gap: 12px; border-top: 1px solid rgba(255,255,255,.06); flex: 0 0 auto; }
.foot .legend { margin-left: auto; display: flex; align-items: center; gap: 5px; }
.foot .legend .gear-ico { width: 12px; height: 12px; color: #fb7299; }
.foot .legend .gear-ico svg { width: 12px; height: 12px; }
.reload { display: none; cursor: pointer; color: #fff; background: #fb7299; border: none; border-radius: 9px; padding: 6px 14px; font-size: 12px; font-family: inherit; font-weight: 500; }
.foot.dirty .reload { display: inline-block; }
.foot.dirty .note { color: #fb7299; }

@media (prefers-color-scheme: light) {
  .gear { background: rgba(255,255,255,.95); color: #18191c; border-color: rgba(0,0,0,.08); box-shadow: 0 3px 14px rgba(0,0,0,.14); }
  .card { background: #fff; color: #18191c; box-shadow: 0 16px 56px rgba(0,0,0,.22); }
  .head { border-bottom-color: rgba(0,0,0,.07); }
  .head .brand { color: #d6336c; }
  .head .close { border-color: rgba(0,0,0,.12); background: rgba(0,0,0,.04); color: rgba(0,0,0,.55); }
  .head .close:hover { color: #d6336c; border-color: #d6336c; }
  .main .nav { border-right-color: rgba(0,0,0,.07); }
  .nav-cat { color: rgba(0,0,0,.4); }
  .nav-item:hover { background: rgba(0,0,0,.05); }
  .nav-item.sel { background: rgba(214,51,108,.12); }
  .nav-item .nm { color: rgba(0,0,0,.82); }
  .nav-item.sel .nm { color: #d6336c; }
  .nav-item:hover .gear-ico, .nav-item.sel .gear-ico, .foot .legend .gear-ico { color: #d6336c; }
  .detail-desc { color: rgba(0,0,0,.5); }
  .field .flabel { color: rgba(0,0,0,.75); }
  .field .hint { color: rgba(0,0,0,.42); }
  .field input[type=text], .field textarea, .field select { background: rgba(0,0,0,.04); color: #18191c; border-color: rgba(0,0,0,.14); }
  .field input[type=text]:focus, .field textarea:focus, .field select:focus { border-color: #d6336c; }
  .empty { color: rgba(0,0,0,.35); }
  .sw .track { background: rgba(0,0,0,.16); }
  .sw input:checked + .track { background: #d6336c; }
  .callout { background: rgba(0,0,0,.04); color: rgba(0,0,0,.6); }
  .callout.warn { background: rgba(214,51,108,.1); color: rgba(0,0,0,.75); }
  .callout.warn .ci { color: #d6336c; }
  .callout a { color: #d6336c; }
  .status { background: rgba(0,0,0,.05); color: rgba(0,0,0,.55); }
  .status .dot { background: rgba(0,0,0,.3); }
  .status.on { background: rgba(214,51,108,.12); color: #d6336c; }
  .status.on .dot { background: #d6336c; box-shadow: 0 0 0 3px rgba(214,51,108,.18); }
  .feed-btn { background: #d6336c; }
  .feed-btn.ghost { border-color: rgba(0,0,0,.2); color: #18191c; }
  .foot { color: rgba(0,0,0,.45); border-top-color: rgba(0,0,0,.07); }
  .reload { background: #d6336c; }
  .foot.dirty .note { color: #d6336c; }
}
`

const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`

function el(tag: string, cls?: string | null, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
const WARN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'

// 提示块：图标 + 富文本（可含链接）。variant='warn' 用品牌色调强调。
function callout(html: string, variant: 'info' | 'warn' = 'info'): HTMLElement {
  const c = el('div', 'callout' + (variant === 'warn' ? ' warn' : ''))
  c.innerHTML = `<span class="ci">${variant === 'warn' ? WARN_SVG : INFO_SVG}</span><span class="ctext">${html}</span>`
  return c
}

function markDirty(): void {
  if (footEl) footEl.classList.add('dirty')
}

function switchEl(checked: boolean, onChange: (on: boolean) => void, small = false): HTMLElement {
  const sw = el('span', 'sw' + (small ? ' sm' : ''))
  const inp = document.createElement('input')
  inp.type = 'checkbox'
  inp.checked = checked
  const track = el('span', 'track')
  inp.addEventListener('change', () => onChange(inp.checked))
  sw.append(inp, track)
  return sw
}

function renderField(m: BiliKitModule, f: SettingField): HTMLElement {
  const wrap = el('div')
  const cur = getField(m, f.key)

  if (f.type === 'toggle') {
    // 列布局：标签+开关同一行(toggle-head)，hint 落到下一行（由底部统一 append）。
    wrap.className = 'field'
    const head = el('div', 'toggle-head')
    const lab = el('span', 'flabel', f.label)
    const sw = switchEl(!!cur, (on) => { setField(m.id, f.key, on); markDirty() })
    head.append(lab, sw)
    wrap.append(head)
  } else if (f.type === 'select') {
    wrap.className = 'field'
    wrap.appendChild(el('span', 'flabel', f.label))
    const sel = document.createElement('select')
    const presets = f.options.map((o) => o.value)
    for (const o of f.options) {
      const opt = document.createElement('option')
      opt.value = o.value
      opt.textContent = o.label
      sel.appendChild(opt)
    }
    const CUSTOM = '__custom__'
    let input: HTMLInputElement | null = null
    if (f.allowCustom) {
      const opt = document.createElement('option')
      opt.value = CUSTOM
      opt.textContent = '自定义…'
      sel.appendChild(opt)
      input = document.createElement('input')
      input.type = 'text'
      if (f.customPlaceholder) input.placeholder = f.customPlaceholder
      input.addEventListener('input', () => { setField(m.id, f.key, input!.value); markDirty() })
    }
    const isPreset = presets.includes(cur as string)
    if (f.allowCustom && !isPreset && cur) {
      sel.value = CUSTOM
      input!.value = String(cur)
      input!.style.display = ''
    } else {
      const useDefault = !isPreset // 存的值已不在当前选项里 → 显示默认
      sel.value = useDefault ? f.default : String(cur)
      // 回写默认，避免「面板显示默认、实际仍用已失效的旧值」的 UI/配置不一致
      if (useDefault && String(cur) !== f.default) setField(m.id, f.key, f.default)
      if (input) input.style.display = 'none'
    }
    sel.addEventListener('change', () => {
      if (sel.value === CUSTOM && input) {
        input.style.display = ''
        setField(m.id, f.key, input.value)
        input.focus()
      } else {
        if (input) input.style.display = 'none'
        setField(m.id, f.key, sel.value)
      }
      markDirty()
    })
    wrap.appendChild(sel)
    if (input) wrap.appendChild(input)
  } else if (f.type === 'textarea') {
    wrap.className = 'field'
    wrap.appendChild(el('span', 'flabel', f.label))
    const ta = document.createElement('textarea')
    ta.value = String(cur ?? '')
    if (f.placeholder) ta.placeholder = f.placeholder
    ta.addEventListener('change', () => { setField(m.id, f.key, ta.value); markDirty() })
    wrap.appendChild(ta)
  } else {
    wrap.className = 'field'
    wrap.appendChild(el('span', 'flabel', f.label))
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.value = String(cur ?? '')
    if (f.placeholder) inp.placeholder = f.placeholder
    inp.addEventListener('change', () => { setField(m.id, f.key, inp.value); markDirty() })
    wrap.appendChild(inp)
  }

  if (f.hint) wrap.appendChild(el('div', 'hint', f.hint))
  return wrap
}

function emptyState(main: string, sub?: string): HTMLElement {
  const e = el('div', 'empty')
  e.appendChild(el('div', 'ei', '◔'))
  e.appendChild(el('div', null, main))
  if (sub) e.appendChild(el('div', 'es', sub))
  return e
}

/* ------------------------------------------------------------------ *
 * 左栏（分组 + 每行 名字/粉点/开关）
 * ------------------------------------------------------------------ */
function navItemModule(m: BiliKitModule): HTMLElement {
  const row = el('div', 'nav-item' + (selected === m.id ? ' sel' : ''))
  const wrap = el('div', 'nm-wrap')
  wrap.appendChild(el('span', 'nm', m.name))
  if (m.settings && m.settings.length) { const g = el('span', 'gear-ico'); g.innerHTML = GEAR_SVG; wrap.appendChild(g) }
  row.appendChild(wrap)
  const sw = switchEl(isModuleEnabled(m), (on) => { setModuleEnabled(m.id, on); markDirty() }, true)
  sw.addEventListener('click', (e) => e.stopPropagation()) // 点开关不触发选中
  row.appendChild(sw)
  row.addEventListener('click', () => select(m.id))
  return row
}

// 通用「特殊项」行（Feed 登录 / 打开方式），非模块，带齿轮、可选中
function navItemSpecial(id: string, name: string): HTMLElement {
  const row = el('div', 'nav-item' + (selected === id ? ' sel' : ''))
  const wrap = el('div', 'nm-wrap')
  wrap.appendChild(el('span', 'nm', name))
  const g = el('span', 'gear-ico'); g.innerHTML = GEAR_SVG; wrap.appendChild(g)
  row.appendChild(wrap)
  row.addEventListener('click', () => select(id))
  return row
}

function renderNav(): void {
  if (!navEl) return
  navEl.textContent = ''
  const cats: string[] = []
  const byCat = new Map<string, BiliKitModule[]>()
  for (const m of getModules()) {
    const c = m.category || '其它'
    if (!byCat.has(c)) { byCat.set(c, []); cats.push(c) }
    byCat.get(c)!.push(m)
  }
  if (!cats.includes(FEED_CAT)) cats.push(FEED_CAT)
  for (const c of cats) {
    navEl.appendChild(el('div', 'nav-cat', c))
    for (const m of byCat.get(c) || []) navEl.appendChild(navItemModule(m))
    // 「打开方式」归入「播放」组（已与 Feed 解耦，是全站视频打开行为，非 Feed 专属）
    if (c === '播放') navEl.appendChild(navItemSpecial(OPEN_ID, '打开方式'))
    if (c === FEED_CAT) {
      navEl.appendChild(navItemSpecial(FEED_ID, 'App 推荐 Feed'))
      navEl.appendChild(navItemSpecial(PREVIEW_ID, '封面预览'))
    }
  }
  // 「关于」永远置于最末，自成一组
  navEl.appendChild(el('div', 'nav-cat', ABOUT_CAT))
  navEl.appendChild(navItemSpecial(ABOUT_ID, '关于 BiliKit-Web'))
}

/* ------------------------------------------------------------------ *
 * 右栏（当前选中项的配置 / 空态 / Feed 登录）
 * ------------------------------------------------------------------ */
function renderFeedDetail(d: HTMLElement): void {
  const loggedIn = !!get<string>('feed.accessKey', '')
  d.appendChild(el('div', 'detail-title', 'App 推荐 Feed'))
  d.appendChild(el('div', 'detail-desc', '首页换成手机 App 的推荐流（需另装 BiliKit-Web Feed 脚本）'))
  // 在首页却探不到 Feed 心跳 → 提示未安装（仅首页判定：Feed 只在首页运行）
  const onHome = location.pathname === '/' || location.pathname === '/index.html'
  const feedAlive = Number(localStorage.getItem('bilikit:alive.feed') || 0)
  if (onHome && Date.now() - feedAlive > 8000) {
    d.appendChild(callout('未检测到 <b>BiliKit-Web Feed</b>，首页推荐流需要它。<a href="https://github.com/shiinayane/BiliKit-Web" target="_blank" rel="noopener">前往安装</a>', 'warn'))
  }
  const fields = el('div', 'fields')

  const row = el('div', 'field row')
  row.appendChild(el('span', 'flabel', '登录状态'))
  const st = el('span', 'status' + (loggedIn ? ' on' : ''))
  const setStatus = (t: string) => { st.innerHTML = `<span class="dot"></span>${t}` }
  setStatus(loggedIn ? '已登录 · 个性化推荐' : '未登录 · 匿名（内容有限）')
  row.appendChild(st)
  fields.appendChild(row)
  const btn = el('button', 'feed-btn' + (loggedIn ? ' ghost' : ''), loggedIn ? '退出登录' : '扫码登录（TV）')
  btn.addEventListener('click', () => {
    if (loggedIn) {
      set('feed.accessKey', '')
      location.reload()
    } else {
      setStatus('正在拉起二维码…')
      startTvLogin((accessKey) => {
        // 落盘失败（隐私模式/存储超限）时明确报错——否则「登录成功」但刷新后仍匿名，静默误导
        if (!set('feed.accessKey', accessKey)) console.error('[BiliKit-Web] access_key 持久化失败：刷新后可能仍为匿名（浏览器隐私模式或存储已满）。')
      })
    }
  })
  fields.appendChild(btn)
  fields.appendChild(callout(loggedIn ? '退出后回到匿名推荐并刷新。' : '用手机哔哩哔哩扫码，获得个性化、不重复的 App 推荐。'))
  d.appendChild(fields)
}

// 打开方式：全站点视频如何打开（抽屉 / 网页全屏抽屉 / 新标签 / 当前页）。每次点击时读取，无需刷新。
function renderOpenDetail(d: HTMLElement): void {
  d.appendChild(el('div', 'detail-title', '打开方式'))
  d.appendChild(el('div', 'detail-desc', '全站（首页 / 搜索 / 收藏 / 历史 / 空间…）点视频时如何打开'))
  const fields = el('div', 'fields')
  const modeRow = el('div', 'field')
  modeRow.appendChild(el('span', 'flabel', '视频打开方式'))
  const modeSel = document.createElement('select')
  for (const [val, label] of [['drawer', '抽屉'], ['drawer-web', '抽屉 · 网页全屏'], ['newtab', '新标签页'], ['current', '当前页']]) {
    const o = document.createElement('option')
    o.value = val
    o.textContent = label
    modeSel.appendChild(o)
  }
  modeSel.value = get<string>('feed.openMode', DEFAULT_OPEN_MODE)
  modeRow.appendChild(modeSel)
  fields.appendChild(modeRow)

  // 「沉浸式揭幕」开关：仅网页全屏模式下有意义（控制是否延迟揭幕以藏过渡），故随模式显隐。
  const immRow = el('div', 'field')
  const immHead = el('div', 'toggle-head')
  immHead.append(el('span', 'flabel', '隐藏切换过程'), switchEl(get<boolean>('feed.drawerImmersive', true), (on) => set('feed.drawerImmersive', on)))
  immRow.append(immHead, el('div', 'hint', '开：等播放器铺满后再显示，看不到从普通页切到全屏的过程（加载稍久一点）。关：先显示、再当场铺满，会瞥见这下切换。'))
  fields.appendChild(immRow)

  // Safari 新标签专属：只压扁 BiliKit-Web 自动打开的子标签中的跨视频 SPA 历史。
  // 普通标签、当前页和抽屉不带一次性 window.name 标记，永远不会受这个开关影响。
  const flattenRow = el('div', 'field')
  const flattenHead = el('div', 'toggle-head')
  flattenHead.append(
    el('span', 'flabel', 'Safari 左滑回到来源页'),
    switchEl(
      get<boolean>(NEW_TAB_HISTORY_FLATTEN_KEY, DEFAULT_NEW_TAB_HISTORY_FLATTEN),
      (on) => set(NEW_TAB_HISTORY_FLATTEN_KEY, on),
    ),
  )
  const safari = isSafariUserAgent(navigator.userAgent, navigator.vendor)
  flattenRow.append(
    flattenHead,
    el('div', 'hint', safari
      ? '实验性：保留来源关系并把子标签里的跨视频 SPA 历史压成一层，让 Safari 两指左滑关闭视频标签并回到来源页。分 P、整页跳转仍保留原生历史。'
      : '仅 Safari 生效；Chrome、Edge、Firefox不会改变历史。实验性开关默认关闭。'),
  )
  fields.appendChild(flattenRow)

  const syncModeRows = (): void => {
    immRow.style.display = modeSel.value === 'drawer-web' ? '' : 'none'
    flattenRow.style.display = modeSel.value === 'newtab' ? '' : 'none'
  }
  syncModeRows()
  modeSel.addEventListener('change', () => { set('feed.openMode', modeSel.value); syncModeRows() })

  fields.appendChild(callout('作用于「浏览 / 列表」页（首页 / 搜索 / 收藏 / 历史 / 空间 / 动态…）点视频。<br><b>新标签页（默认）</b>：首页原样保留，关掉视频标签即可完整结束这一播放上下文。<br><b>当前页</b>：顶层导航最利于回收；返回后恢复 Feed 卡片、游标和滚动位置。<br><b>抽屉</b>：不离开列表、切换最快，但会常驻最后一个完整视频文档。<br><b>视频播放页内</b>点相关视频走原生跳转，配合左下角「回程」胶囊一键跳回。'))
  d.appendChild(fields)
}

// 封面预览方式：真视频（低清 dash 静音自动播）/ 雪碧图 / 关闭。Feed 建卡时读取，改后刷新页面生效。
function renderPreviewDetail(d: HTMLElement): void {
  d.appendChild(el('div', 'detail-title', '封面预览'))
  d.appendChild(el('div', 'detail-desc', '鼠标悬停封面时的预览方式'))
  const fields = el('div', 'fields')
  const row = el('div', 'field')
  row.appendChild(el('span', 'flabel', '预览方式'))
  const sel = document.createElement('select')
  for (const [val, label] of [['video', '真视频'], ['sprite', '雪碧图'], ['off', '关闭']]) {
    const o = document.createElement('option')
    o.value = val
    o.textContent = label
    sel.appendChild(o)
  }
  sel.value = get<string>('feed.previewMode', 'video')
  sel.addEventListener('change', () => { set('feed.previewMode', sel.value); markDirty() })
  row.appendChild(sel)
  fields.appendChild(row)
  fields.appendChild(callout('<b>真视频</b>：悬停即拉低清视频、静音自动播，最接近手机 App 的秒开（比雪碧图费流量）。<br><b>雪碧图</b>：只拉缩略帧轮播，省流量、更轻。<br><b>关闭</b>：悬停不预览。'))
  d.appendChild(fields)
}

// 关于：版本号 + 仓库 / 反馈 / GreasyFork 链接（新标签打开）
function renderAboutDetail(d: HTMLElement): void {
  d.appendChild(el('div', 'detail-title', '关于 BiliKit-Web'))
  d.appendChild(el('div', 'detail-desc', 'B 站体验增强套件 · Safari 友好、无需扩展、零外部依赖 · 作者 shiinayane · MIT'))
  const fields = el('div', 'fields')

  const vrow = el('div', 'field row')
  vrow.appendChild(el('span', 'flabel', '版本'))
  const pill = el('span', 'status on')
  pill.innerHTML = `<span class="dot"></span>Core v${VERSION}`
  vrow.appendChild(pill)
  fields.appendChild(vrow)

  // Feed 版本：Feed 启动时写 localStorage；按心跳判在装/未装（避免读到卸载后残留的旧版本号）
  const feedAlive = Date.now() - Number(localStorage.getItem('bilikit:alive.feed') || 0) < 15000
  const feedVer = localStorage.getItem('bilikit:feed.version') || ''
  const frow = el('div', 'field row')
  frow.appendChild(el('span', 'flabel', 'Feed'))
  const fpill = el('span', 'status' + (feedAlive && feedVer ? ' on' : ''))
  fpill.innerHTML = `<span class="dot"></span>${feedAlive && feedVer ? `Feed v${feedVer}` : '未安装'}`
  frow.appendChild(fpill)
  fields.appendChild(frow)

  fields.appendChild(callout(
    '<a href="https://github.com/shiinayane/BiliKit-Web" target="_blank" rel="noopener">GitHub 仓库</a> · ' +
    '<a href="https://github.com/shiinayane/BiliKit-Web/issues" target="_blank" rel="noopener">反馈 / 报 Bug</a> · ' +
    '<a href="https://greasyfork.org/zh-CN/scripts/585248-bilikit-core" target="_blank" rel="noopener">GreasyFork 主页</a>',
  ))
  fields.appendChild(callout('<b>开发期 · 快速迭代中</b>：功能可能随时调整，偶有不稳定属正常；B 站接口一变也可能短暂失效。欢迎提 Issue 或建议。', 'warn'))
  d.appendChild(fields)
}

function renderDetail(): void {
  if (!detailEl) return
  detailEl.textContent = ''
  if (selected === FEED_ID) { renderFeedDetail(detailEl); return }
  if (selected === OPEN_ID) { renderOpenDetail(detailEl); return }
  if (selected === PREVIEW_ID) { renderPreviewDetail(detailEl); return }
  if (selected === ABOUT_ID) { renderAboutDetail(detailEl); return }
  const m = getModules().find((x) => x.id === selected)
  if (!m) { detailEl.appendChild(emptyState('选择左侧一项')); return }
  detailEl.appendChild(el('div', 'detail-title', m.name))
  if (m.description) detailEl.appendChild(el('div', 'detail-desc', m.description))
  const hasSettings = !!(m.settings && m.settings.length)
  if (hasSettings || m.note) {
    const fields = el('div', 'fields')
    if (m.note) fields.appendChild(callout(m.note)) // 模块说明/取舍
    if (m.settings) for (const f of m.settings) fields.appendChild(renderField(m, f))
    detailEl.appendChild(fields)
  } else {
    detailEl.appendChild(emptyState('此模块无额外配置', '开关在左侧列表'))
  }
}

function firstNavId(): string {
  const ms = getModules()
  return ms.length ? ms[0].id : FEED_ID
}

function select(id: string): void {
  selected = id
  renderNav()
  renderDetail()
}

export function mountPanel(): void {
  if (window.top !== window.self) return
  // 设置齿轮只在首页显示，不打扰其它页面（设置已跨子域共享，首页配好全站生效）
  const home = (location.hostname === 'www.bilibili.com' || location.hostname === 'bilibili.com') && (location.pathname === '/' || location.pathname === '/index.html')
  if (!home) return
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', mountPanel, { once: true })
    return
  }
  if (document.getElementById(PANEL_ID)) return

  const root = el('div')
  root.id = PANEL_ID
  const sr = root.attachShadow({ mode: 'open' })
  sr.innerHTML = `<style>${STYLE}</style>`

  const gear = el('div', 'gear')
  gear.title = 'BiliKit-Web 设置'
  gear.innerHTML = GEAR_SVG

  const overlay = el('div', 'overlay')
  const card = el('div', 'card')

  const head = el('div', 'head')
  head.innerHTML = `<span class="title"><span class="brand">BiliKit-Web</span> 设置</span>`
  const close = el('span', 'close', '×')
  head.appendChild(close)

  const main = el('div', 'main')
  navEl = el('div', 'nav')
  detailEl = el('div', 'detail')
  main.append(navEl, detailEl)

  footEl = el('div', 'foot')
  const note = el('span', 'note', '改动需刷新页面生效')
  const reload = el('button', 'reload', '刷新')
  reload.addEventListener('click', () => location.reload())
  const legend = el('div', 'legend')
  const lg = el('span', 'gear-ico')
  lg.innerHTML = GEAR_SVG
  legend.append(lg, el('span', null, '有可调项'))
  footEl.append(note, reload, legend)

  card.append(head, main, footEl)
  overlay.appendChild(card)

  const open = () => {
    if (!selected || (selected !== FEED_ID && selected !== OPEN_ID && selected !== PREVIEW_ID && selected !== ABOUT_ID && !getModules().some((m) => m.id === selected))) selected = firstNavId()
    renderNav()
    renderDetail()
    overlay.classList.add('open')
  }
  const closePanel = () => overlay.classList.remove('open')
  gear.addEventListener('click', open)
  close.addEventListener('click', closePanel)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel() })

  sr.append(gear, overlay)
  document.body.appendChild(root)

  // 与 Feed 右下悬浮按钮(FAB)统一「心智」：Feed 若在跑（首页注入 .bk-feed-fab，body 直接子节点、共享 light DOM），
  // 就把「设置」并进那一列——Core(页面世界)直接往 FAB 里塞一颗按钮、挂 click 开面板，并隐藏自己这颗独立齿轮。
  // Feed 与 Core 不共享 window 但共享 DOM，故无需跨世界信令；Feed @document-idle 晚于本处、且 SPA 会重建 FAB，
  // 用 MutationObserver 持续跟：FAB 在场→并入并隐齿轮；不在场（无 Feed / 已离开首页）→ 露出独立齿轮兜底。
  // 塞进的按钮无前缀类名（与 bk-top/bk-refresh 一致），天然吃 Feed 的 .bk-feed-fab button 样式，观感统一。
  const FAB_GEAR = GEAR_SVG.replace('<svg ', '<svg width="20" height="20" ')
  const syncFab = (): void => {
    const fab = document.querySelector('.bk-feed-fab')
    if (fab) {
      if (!fab.querySelector('.bk-settings')) {
        const b = document.createElement('button')
        b.className = 'bk-settings'
        b.title = 'BiliKit-Web 设置'
        b.setAttribute('aria-label', 'BiliKit-Web 设置')
        b.innerHTML = FAB_GEAR
        b.addEventListener('click', open)
        fab.insertBefore(b, fab.querySelector('.bk-refresh')) // 置于刷新之上：返回顶部 / 设置 / 刷新
      }
      gear.classList.add('hidden')
    } else {
      gear.classList.remove('hidden')
    }
  }
  syncFab()
  // 只盯 body 直接子节点（FAB 挂 body 下）；往 FAB 内塞按钮不改 body childList，不会自触发、无循环
  try { new MutationObserver(syncFab).observe(document.body, { childList: true }) } catch { /* ignore */ }
}
