import { describe, expect, it } from 'vitest'

import { artifactBlockValuePropsSchemas, artifactBlockTextPropsSchemas } from './blocks.ts'
import { sitemapPagesOf, sitemapSiteRequest } from './sitemap.ts'
import { artifactTemplates } from './templates.ts'

// «Структура сайта» (docs/plan/88-artifacts.md, 88.27): the tree of a future site from its nodes.

const node = (key: string, props: Record<string, string> = {}, content = '') => ({
  key,
  kind: 'node',
  parent: null,
  content,
  props,
})

describe('the structure of a site', () => {
  it('reads the pages in the order of the tree, each with its depth and address', () => {
    const pages = sitemapPagesOf([
      node('home', { title: 'Главная', path: '/' }),
      node('contacts', { title: 'Контакты', up: 'home' }),
      node(
        'services',
        { title: 'Услуги', up: 'home', goal: 'Выбрать', action: 'Узнать цену' },
        'Что входит',
      ),
      node('nails', { title: 'Маникюр', up: 'services' }),
    ])
    expect(pages.map((page) => [page.title, page.depth, page.path])).toEqual([
      ['Главная', 0, '/'],
      ['Контакты', 1, '/kontakty'],
      ['Услуги', 1, '/uslugi'],
      ['Маникюр', 2, '/manikyur'],
    ])
    expect(pages[2]).toMatchObject({
      goal: 'Выбрать',
      action: 'Узнать цену',
      brief: 'Что входит',
      up: 'home',
    })
  })

  it('puts a page whose parent is gone, or makes a loop, at the top', () => {
    const pages = sitemapPagesOf([
      node('a', { title: 'А', up: 'b' }),
      node('b', { title: 'Б', up: 'a' }),
      node('c', { title: 'В', up: 'nobody' }),
    ])
    expect(pages.every((page) => page.depth <= 1)).toBe(true)
    expect(pages.find((page) => page.key === 'c')?.up).toBeNull()
    expect(new Set(pages.map((page) => page.path)).size).toBe(3)
  })

  it('keeps a node’s parent, address and main action in its schemas', () => {
    expect(
      artifactBlockValuePropsSchemas.node.safeParse({ up: 'home', path: '/uslugi', x: 1 }).success,
    ).toBe(true)
    expect(artifactBlockValuePropsSchemas.node.safeParse({ path: 'uslugi' }).success).toBe(false)
    expect(
      artifactBlockTextPropsSchemas.node.safeParse({ title: 'Услуги', action: 'Записаться' })
        .success,
    ).toBe(true)
  })

  it('has a template of a site of services, and asks the agent for a canvas of it', () => {
    const template = artifactTemplates.find((each) => each.id === 'service-site')!
    const pages = sitemapPagesOf(
      template.blocks.map((block) =>
        node(block.key!, block.props as Record<string, string>, block.content),
      ),
    )
    expect(pages.map((page) => page.title)).toEqual([
      'Главная',
      'Услуги',
      'Цены',
      'Отзывы',
      'Контакты',
    ])
    expect(pages[0]!.path).toBe('/')
    expect(sitemapSiteRequest('@artifact:x')).toContain('холст сайта по структуре @artifact:x')
  })
})
