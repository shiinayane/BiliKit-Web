import { describe, expect, it } from 'vitest'
import { rootBootstrapBackground } from './index'

describe('theme-sync root bootstrap background', () => {
  it('只在深色页面仍加载时提供防闪白背景', () => {
    expect(rootBootstrapBackground(true, 'loading')).toBe('#18191c')
    expect(rootBootstrapBackground(false, 'loading')).toBe('')
  })

  it('DOM 就绪后清除根背景，避免遮住个人空间的负层级头图', () => {
    expect(rootBootstrapBackground(true, 'interactive')).toBe('')
    expect(rootBootstrapBackground(true, 'complete')).toBe('')
  })
})
