// 客户端入口的 inject 契约。
//
// 存在的理由是一次真事故：rc.4 发布版里这份列表只写了 `'remote'`，而代码读的是
// `ctx.remote.session`。cordis 按路径逐段放行（vendor/cordis 的 reflect.ts），
// 于是插件在 applyShortcuts 的第一次服务查找就抛 `cannot get property
// "remote.session" without inject`。Navigator 退役后 applyShortcuts 是唯一的
// apply 入口，异常又被 GA-043 的 fail-soft 吞掉，结果是：插件加载、什么都不注册、
// 页面照常，只在浏览器控制台留一行 warn。装出来的包是活的，功能是死的。
//
// 当时**有**单元测试断言 inject 含 `'remote'`——它是绿的，因为那确实在里面。
// 手写清单跟不上代码，所以这里不写清单：从源码里找出代码实际解引用的每个
// `ctx.remote.<ns>`，逐个要求 inject 里有对应的 `'remote.<ns>'`。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { inject } from './index.js'

/** 递归收集 src 下的 TS/TSX 源码（跳过测试文件本身）。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue
    out.push(full)
  }
  return out
}

describe('client entry inject contract', () => {
  const root = join(process.cwd(), 'src')
  const sources = sourceFiles(root).map(file => readFileSync(file, 'utf8'))

  it('finds the plugin sources it is meant to scan', () => {
    expect(sources.length).toBeGreaterThan(10)
  })

  it('declares every ctx.remote namespace the client dereferences', () => {
    const reached = new Set<string>()
    for (const source of sources) {
      // `services.remote.session.create(...)`、`ctx.remote?.session` 等都算。
      // 只取标识符形式的属性，跳过 `remote.session` 出现在注释里的情况没有必要
      // ——注释里提到某个命名空间，通常正说明代码在用它。
      for (const match of source.matchAll(/\bremote\??\.([a-zA-Z][A-Za-z0-9]*)/g)) {
        const namespace = match[1]
        if (namespace === undefined) continue
        reached.add(namespace)
      }
    }
    expect(reached.size).toBeGreaterThan(0)
    const declared = new Set<string>(inject as readonly string[])
    for (const namespace of reached) {
      expect(
        declared.has(`remote.${namespace}`),
        `client code dereferences ctx.remote.${namespace}, so inject must declare 'remote.${namespace}'. `
        + 'cordis gates each path segment separately: with only \'remote\' declared it throws '
        + '"cannot get property without inject", the fail-soft catch swallows it, and the whole '
        + 'plugin silently registers nothing.',
      ).toBe(true)
    }
  })

  it('declares the remote root alongside its namespaces', () => {
    const declared = new Set<string>(inject as readonly string[])
    if ([...declared].some(entry => entry.startsWith('remote.'))) {
      expect(declared.has('remote')).toBe(true)
    }
  })
})
