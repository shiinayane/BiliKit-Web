import type { BiliKitModule, Cfg } from '../../core/module'
import { normalizeCdnHost, rewritePlayurl as rewritePlayurlBase } from './core'

/**
 * CDN 优选：把 B 站视频分片重定向到指定 CDN 镜像，绕开被分到的慢节点（海外 Akamai 等）。
 * 迁移自 scripts/cdn-pick.user.js（逻辑逐字保留）。
 * 不设顶层守卫——需在 Float 抽屉 iframe 与 player.bilibili.com 播放器里也跑。
 * runAt='start'：必须在页面用到 fetch / 设置 __playinfo__ 之前挂钩。
 */
function init(cfg: Cfg): void {
  if ((window as any).__BILIKIT_CDN_PICK__) return
  ;(window as any).__BILIKIT_CDN_PICK__ = true

  // 想换的镜像主机（裸域名）。置空 '' = 关闭。来自设置面板（默认 hwb，日本实测首选）。
  const configuredHost = cfg.get<string>('targetHost')
  const TARGET_HOST = configuredHost ? normalizeCdnHost(configuredHost) : null
  // 备用镜像：主镜像打嗝时回退，仍是大陆镜像、绝不回 akam/cosov。
  const BACKUP_HOSTS = ['upos-sz-upcdnbda2.bilivideo.com', 'upos-sz-mirrorhw.bilivideo.com']

  const DEBUG = false
  const log = (...a: unknown[]) => { if (DEBUG) console.log('[CDN优选]', ...a) }

  if (!TARGET_HOST) {
    if (configuredHost) console.warn('[BiliKit-Web] CDN 优选已禁用：自定义节点必须是 bilivideo/acgvideo 受信后缀下的纯主机名。')
    else log('TARGET_HOST 为空，未启用')
    return
  }

  // 纯改写逻辑在 ./core；这里绑定 TARGET_HOST / BACKUP_HOSTS，下游调用点不变
  const rewritePlayurl = (root: any): boolean => rewritePlayurlBase(root, TARGET_HOST, BACKUP_HOSTS)

  const PLAYURL_PATHS = [
    '/x/player/wbi/playurl', '/x/player/playurl',
    '/pgc/player/web/playurl', '/pgc/player/web/v2/playurl', '/pgc/player/api/playurl',
    '/pugv/player/web/playurl',
  ]
  const isPlayurl = (u: any) => typeof u === 'string' && PLAYURL_PATHS.some((p) => u.includes(p))

  // 一、首帧：window.__playinfo__（服务端内联，早于任何接口）
  let playinfo: any
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get: () => playinfo,
      set: (v) => {
        try { if (rewritePlayurl(v)) log('__playinfo__ 改写', TARGET_HOST) } catch (_) {}
        playinfo = v
      },
    })
  } catch (_) {}

  // 二、换片/切档：fetch 与 XHR 的 playurl 响应（只 hook 主线程）
  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = async function (input: any, _init?: any) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input || '')
      const resp = await origFetch.apply(this, arguments as any)
      if (!isPlayurl(url)) return resp
      try {
        const text = await resp.clone().text()
        const obj = JSON.parse(text)
        if (rewritePlayurl(obj)) {
          log('fetch playurl 改写', TARGET_HOST)
          // 剥掉 content-length / content-encoding——正文已解码且长度变了
          const headers = new Headers(resp.headers)
          headers.delete('content-length')
          headers.delete('content-encoding')
          return new Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers })
        }
      } catch (_) {}
      return resp
    } as any
  }

  const OX = window.XMLHttpRequest
  if (OX) {
    class X extends OX {
      __cdnUrl: any
      open(method: any, url: any) {
        this.__cdnUrl = url
        return super.open.apply(this, arguments as any)
      }
      get responseText() {
        const rt = this.responseType
        if (rt !== '' && rt !== 'text') return super.responseText
        return this.__cdnText(super.responseText)
      }
      get response() {
        const r = super.response
        if (this.readyState !== 4 || !isPlayurl(this.__cdnUrl)) return r
        if (typeof r === 'string') return this.__cdnText(r)
        if (r && typeof r === 'object') { try { if (rewritePlayurl(r)) log('xhr(json) playurl 改写', TARGET_HOST) } catch (_) {} }
        return r
      }
      __cdnText(raw: any) {
        if (this.readyState !== 4 || typeof raw !== 'string' || !isPlayurl(this.__cdnUrl)) return raw
        try {
          const obj = JSON.parse(raw)
          if (rewritePlayurl(obj)) { log('xhr playurl 改写', TARGET_HOST); return JSON.stringify(obj) }
        } catch (_) {}
        return raw
      }
    }
    window.XMLHttpRequest = X as any
  }

  log('已启用 →', TARGET_HOST)
}

export const cdnPick: BiliKitModule = {
  id: 'cdn-pick',
  name: 'CDN 优选',
  description: '视频分片重定向到更快的大陆镜像',
  category: '播放',
  runAt: 'start',
  settings: [
    {
      key: 'targetHost',
      type: 'select',
      label: 'CDN 镜像节点',
      default: 'upos-sz-mirrorhwb.bilivideo.com',
      options: [
        { label: '华为 hwb（日本实测首选）', value: 'upos-sz-mirrorhwb.bilivideo.com' },
        { label: '百度 bda2（地板最高）', value: 'upos-sz-upcdnbda2.bilivideo.com' },
        { label: '华为 hw', value: 'upos-sz-mirrorhw.bilivideo.com' },
        { label: '阿里 alib', value: 'upos-sz-mirroralib.bilivideo.com' },
        { label: '阿里 ali', value: 'upos-sz-mirrorali.bilivideo.com' },
        { label: '腾讯 cos', value: 'upos-sz-mirrorcos.bilivideo.com' },
        { label: '腾讯 cosb', value: 'upos-sz-mirrorcosb.bilivideo.com' },
        { label: '网宿 ws', value: 'upos-sz-upcdnws.bilivideo.com' },
        { label: '关闭（用 B 站默认分配）', value: '' },
      ],
      allowCustom: true,
      customPlaceholder: 'upos-sz-mirrorXXX.bilivideo.com',
      hint: '把视频分片钉到该大陆镜像，绕开慢节点；选「自定义…」可手填镜像主机（须 upos 系 .bilivideo.com，否则会 403）',
    },
  ],
  init,
}
