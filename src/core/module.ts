import { isModuleEnabled, makeCfg } from './settings'

/**
 * 一个 BiliKit-Web 模块 = 原来一个独立 .user.js 的等价物。
 * 迁移约定：把原脚本的 IIFE 主体搬进 init()，去掉 ==UserScript== 头与外层 IIFE，
 * 保留内部的单例守卫（与仍在用的旧独立脚本共存时防重复）。
 *
 * init() 必须能在「任意 B 站页面」被调用而安全无害——多数模块本就靠 observer/轮询自我
 * 适配页面类型（wake-lock 等 video 事件、comment-location 等 #commentapp），因此不做
 * 每模块 URL 匹配；个别只针对首页的（home-clean）在自身逻辑里自检。这样对 SPA 天然健壮。
 */
/**
 * 声明式配置项：模块自报可调项，设置面板据此「自动」渲染控件，无需手写面板表单。
 * 模块内经 init(cfg) 的 cfg.get(key) 读取当前值（缺省回落到这里的 default）。
 * 加一个新选项 = 这里多声明一行，面板自动多一个控件。
 */
export type SettingField =
  | { key: string; type: 'toggle'; label: string; default: boolean; hint?: string }
  | { key: string; type: 'text'; label: string; default: string; placeholder?: string; hint?: string }
  | { key: string; type: 'textarea'; label: string; default: string; placeholder?: string; hint?: string }
  | { key: string; type: 'select'; label: string; default: string; options: { label: string; value: string }[]; allowCustom?: boolean; customPlaceholder?: string; hint?: string }

/** 传给 init 的配置读取器，绑定到该模块自身的命名空间 */
export interface Cfg {
  get<T = any>(key: string): T
}

export interface BiliKitModule {
  /** 稳定 id，用作设置键，勿随意改 */
  id: string
  /** 设置面板显示名 */
  name: string
  /** 设置面板副标题 */
  description?: string
  /** 模块页顶部说明/取舍（callout，支持简单 HTML）；可选 */
  note?: string
  /** 左栏分组类别（如「播放」「界面」）；缺省归入「其它」 */
  category?: string
  /** 默认是否启用，缺省 true */
  defaultEnabled?: boolean
  /** 'start'：注册即跑；'idle'：DOM 就绪后跑（默认 'start'） */
  runAt?: 'start' | 'idle'
  /** 声明式配置项，供设置面板自动渲染 */
  settings?: SettingField[]
  /** 模块入口，等价于原脚本主体。cfg 读取本模块的可调项。 */
  init: (cfg: Cfg) => void
}

const registry: BiliKitModule[] = []

export function register(...mods: BiliKitModule[]): void {
  for (const m of mods) {
    if (registry.some((x) => x.id === m.id)) {
      console.warn(`[BiliKit-Web] 模块 id 重复，已忽略：${m.id}`)
      continue
    }
    registry.push(m)
  }
}

export function getModules(): readonly BiliKitModule[] {
  return registry
}

/** 运行所有「已启用」模块。init 出错只记录、不连累其他模块。 */
export function runAll(): void {
  for (const m of registry) {
    if (!isModuleEnabled(m)) continue
    const go = () => {
      try {
        m.init(makeCfg(m))
      } catch (e) {
        console.error(`[BiliKit-Web] 模块「${m.id}」初始化出错：`, e)
      }
    }
    if (m.runAt === 'idle' && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', go, { once: true })
    } else {
      go()
    }
  }
}
