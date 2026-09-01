/**
 * 词典里少数几条**会自己拼句子**的文案的守卫。
 *
 * 宿主的翻译器只做 `{name}` 字面替换，一点复数机制都没有
 * （`dsh-client-locale` 的 `translate()` 就一句
 * `template.replace(/\{(\w+)\}/g, …)`），所以英文侧凡是会渲染出 1 的计数，
 * 都只能走本词典既有的括号后缀惯例（`selection.dock.labelCount` 就是这么写的）。
 * key 集合的对齐由 `en satisfies Record<WorkbenchLocaleKey, string>` 在编译期
 * 管住，这里只管**渲染出来的那句话读不读得通**。
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from './dictionaries.js'

const render = (template: string, count: number) => template.replace(/\{count\}/g, String(count))

/**
 * chip 与它的无障碍名 —— 唯一会以 count = 1 渲染的英文计数文案：chip 从第一条
 * 引用起就常驻在 composer 上方，英文界面下一眼可见。
 * （`selection.quote.headingMultiple` 不在此列：那条按构造只用于 ≥2。）
 */
const SINGULAR_CAPABLE = ['selection.chip.label', 'selection.chip.aria'] as const

describe('dictionaries', () => {
  it('never renders "1 quotes" — the English chip counts in parentheses', () => {
    for (const key of SINGULAR_CAPABLE) {
      // `{count}` 后面直接跟一个词，就是 `{count} quotes` 在 count = 1 时
      // 渲染成 "1 quotes" 的那个形状。括号后缀在任何 count 下都成立。
      expect(en[key], `${key}: ${en[key]}`).not.toMatch(/\{count\} [A-Za-z]/)
      expect(render(en[key], 1), key).toContain('1')
      expect(render(en[key], 7), key).toContain('7')
    }
  })

  it('says “引用 / quote” on both sides, never “注释 / note”', () => {
    // aggregate 里每一条都会随消息发出去，其中可能一条评论都没有——用「注释」
    // 配引用数在 0 条评论时是句假话。中英两侧必须是同一个口径。
    for (const key of SINGULAR_CAPABLE) {
      expect(zh[key], key).toContain('引用')
      expect(zh[key], key).not.toContain('注释')
      expect(en[key].toLowerCase(), key).toContain('quote')
      expect(en[key].toLowerCase(), key).not.toContain('note')
    }
  })

  it('keeps every placeholder paired across zh and en', () => {
    // 占位符名字对不上 = 那一侧渲染出一个字面的 `{count}` / `{n}`。
    const holders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(holders(en[key]), key).toEqual(holders(zh[key]))
    }
  })
})
