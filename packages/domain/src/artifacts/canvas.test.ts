import { describe, expect, it } from 'vitest'

import {
  canvasLegacyHome,
  canvasLiveFrames,
  canvasNotesOf,
  canvasPublishedScreens,
  canvasScreensOf,
  canvasSegmentOf,
  canvasThumbKey,
  canvasThumbObjectKey,
  stringHash,
} from './canvas.ts'
import { artifactFrameBlocksOf, artifactFrameDocument, artifactFramePartMark } from './frame.ts'

const block = (
  key: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown> = {},
  content: string | null = '',
  rev = 1,
) => ({ key, kind, parent, props, content, rev })

const canvas = [
  block('common', 'style', null, {}, 'body{margin:0}'),
  block('home', 'frame', null, { name: 'Главная' }),
  block('home-html', 'html', 'home', {}, '<h1>Пекарня</h1>'),
  block('home-js', 'script', 'home', {}, 'console.log(1)'),
  block('a', 'frame', null, { name: 'Услуги', variant: 'А' }),
  block('a-html', 'html', 'a', {}, '<h1>Услуги А</h1>'),
  block('b', 'frame', null, { name: 'Услуги', variant: 'Б', chosen: true, x: 10, y: 20 }),
  block('b-html', 'html', 'b', {}, '<h1>Услуги Б</h1>'),
  block('c', 'frame', null, { name: 'О компании', path: '/o-nas' }),
  block('pin', 'note', 'b', { x: 50, y: 10 }, 'Крупнее кнопку'),
  block('sticky', 'note', null, { x: -400, y: 0, color: 'green' }, 'Идеи'),
  block('settings', 'settings', null, {}, '{"price":100}'),
]

describe('the canvas (Ар8, §7.7, slice 88.15)', () => {
  it('reads its screens in order with their addresses, variants and places', () => {
    const screens = canvasScreensOf(canvas)
    expect(screens.map((screen) => [screen.key, screen.path])).toEqual([
      ['home', '/'],
      ['a', '/uslugi'],
      ['b', '/uslugi'],
      ['c', '/o-nas'],
    ])
    expect(screens[2]).toMatchObject({ variant: 'Б', chosen: true, x: 10, y: 20 })
    expect(canvasSegmentOf('О компании!')).toBe('o-kompanii')
    expect(canvasSegmentOf('***')).toBe('page')
  })

  it('publishes one page a screen: of variants the chosen one', () => {
    const selected = canvasPublishedScreens(canvas)
    expect(selected.map((screen) => screen.key)).toEqual(['home', 'b', 'c'])
    expect(selected[1]).toMatchObject({ key: 'b', frameKeys: ['a', 'b'], path: '/uslugi' })
    const none = canvas.map((each) =>
      each.key === 'b' ? { ...each, props: { name: 'Услуги', variant: 'Б' } } : each,
    )
    expect(canvasPublishedScreens(none).map((screen) => screen.key)).toEqual(['home', 'a', 'c'])
  })

  it('recovers the legacy home when the first frame’s selected variant had another path', () => {
    const frames = [canvas[4]!, canvas[1]!, canvas[6]!]
    expect(canvasPublishedScreens(frames)[0]).toMatchObject({ key: 'b', path: '/' })
    expect(canvasLegacyHome(frames)).toEqual(['home'])
  })

  it('reads sticky notes of the board and pins of its frames', () => {
    expect(canvasNotesOf(canvas)).toEqual([
      { key: 'pin', text: 'Крупнее кнопку', frame: 'b', x: 50, y: 10, color: 'yellow' },
      { key: 'sticky', text: 'Идеи', frame: null, x: -400, y: 0, color: 'green' },
    ])
  })

  it('keeps live at most four frames in view at 30 % and more, none while zooming (spike 6)', () => {
    const visible = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, index) => ({
      key,
      share: 1 - index / 10,
    }))
    expect(canvasLiveFrames({ visible, scale: 0.5, zooming: false })).toEqual(['a', 'b', 'c', 'd'])
    expect(canvasLiveFrames({ visible, scale: 0.29, zooming: false })).toEqual([])
    expect(canvasLiveFrames({ visible, scale: 1, zooming: true })).toEqual([])
    expect(
      canvasLiveFrames({ visible: [{ key: 'x', share: 0 }], scale: 1, zooming: false }),
    ).toEqual([])
  })

  it('keys a thumbnail by the revisions of its document: a note or another screen changes nothing', () => {
    const input = { frame: 'b', title: 'Холст' }
    const key = canvasThumbKey({ ...input, blocks: canvas })
    expect(key).toMatch(/^[0-9a-f]{26}$/)
    const other = canvas.map((each) =>
      each.key === 'a-html' || each.key === 'pin' ? { ...each, rev: 9 } : each,
    )
    expect(canvasThumbKey({ ...input, blocks: other })).toBe(key)
    const mine = canvas.map((each) => (each.key === 'b-html' ? { ...each, rev: 2 } : each))
    expect(canvasThumbKey({ ...input, blocks: mine })).not.toBe(key)
    const common = canvas.map((each) => (each.key === 'common' ? { ...each, rev: 2 } : each))
    expect(canvasThumbKey({ ...input, blocks: common })).not.toBe(key)
    expect(stringHash('a')).not.toBe(stringHash('b'))
    expect(
      canvasThumbObjectKey({
        workspaceId: '0196ABCD-0000-7000-8000-000000000001',
        artifactId: '0196abcd-0000-7000-8000-000000000002',
        key,
        width: 390,
      }),
    ).toBe(
      `artifacts/0196abcd-0000-7000-8000-000000000001/0196abcd-0000-7000-8000-000000000002/thumbs/${key}-390.jpg`,
    )
  })

  it('assembles one frame of a canvas after the common style', () => {
    const parts = artifactFrameBlocksOf({ blocks: canvas, frame: 'home' })!
    expect(parts.html.map((each) => each.key)).toEqual(['home-html'])
    expect(parts.style.map((each) => each.key)).toEqual(['common'])
    expect(parts.script.map((each) => each.key)).toEqual(['home-js'])
    expect(parts.settings?.key).toBe('settings')
    expect(artifactFrameBlocksOf({ blocks: canvas, frame: 'nothing' })).toBeNull()
    expect(artifactFrameBlocksOf({ blocks: canvas, frame: 'home-html' })).toBeNull()
    const html = artifactFrameDocument({
      title: 't',
      platformCss: '',
      bridge: false,
      parts: {
        html: [artifactFramePartMark('home-html') + '<h1>x</h1>'],
        style: [],
        script: [],
        settings: null,
      },
    })
    expect(html).toContain('<!--raditi-block:home-html--><h1>x</h1>')
  })
})
