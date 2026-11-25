import { parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import {
  artifactEditCopy,
  artifactElementOf,
  artifactHtmlParts,
  artifactSvgPart,
  patchArtifactText,
  stampArtifactHtml,
} from './html.ts'
import { markdownImportSections } from './section.ts'

const ids = (html: string) => [...html.matchAll(/data-rid="([^"]+)"/g)].map((match) => match[1])

describe('the ids of the edit frame (Ар9, spike 1)', () => {
  it('stamps each start tag the source has, replacing an id the source carried', () => {
    const stamped = stampArtifactHtml(
      'b1',
      '<section data-rid="x"><h1>Кофе</h1><p>Свежий <b>каждый</b> день</p></section>',
    )
    expect(ids(stamped)).toEqual(['b1.1', 'b1.2', 'b1.3', 'b1.4'])
    expect(stamped).not.toContain('data-rid="x"')
  })

  it('gives no id to what the parser implied (tbody)', () => {
    expect(ids(stampArtifactHtml('t', '<table><tr><td>1</td></tr></table>'))).toEqual([
      't.1',
      't.2',
      't.3',
    ])
  })
})

describe('a patch of the text of one element', () => {
  const source =
    '<div class="hero"><h1>Кофейня «Колос»</h1><p>Свежий <b>хлеб</b> каждый день &amp; кофе</p></div>'

  it('replaces the slots of text in the source, escaping markup, and keeps everything else', () => {
    const patched = patchArtifactText({
      block: 'b1',
      html: source,
      id: 'b1.3',
      shape: ['b#b1.4'],
      edits: [
        { slot: 0, text: 'Тёплый ' },
        { slot: 1, text: ' по утрам <script>' },
      ],
    })
    expect(patched).toEqual({
      ok: true,
      html: '<div class="hero"><h1>Кофейня «Колос»</h1><p>Тёплый <b>хлеб</b> по утрам &lt;script&gt;</p></div>',
    })
  })

  it('fills an empty slot after a child and after the start tag', () => {
    const patched = patchArtifactText({
      block: 'b1',
      html: '<p><img src="a.png">x</p><h2></h2>',
      id: 'b1.3',
      shape: [],
      edits: [{ slot: 0, text: 'Меню' }],
    })
    expect(patched).toEqual({ ok: true, html: '<p><img src="a.png">x</p><h2>Меню</h2>' })
  })

  it('refuses a changed shape, a raw-text element and an id that names nothing', () => {
    expect(
      patchArtifactText({ block: 'b1', html: source, id: 'b1.3', shape: [], edits: [] }),
    ).toEqual({ ok: false, refusal: 'SHAPE_CHANGED' })
    expect(
      patchArtifactText({
        block: 's',
        html: '<noscript><p>нет</p></noscript>',
        id: 's.2',
        shape: [],
        edits: [{ slot: 0, text: 'да' }],
      }),
    ).toEqual({ ok: false, refusal: 'NOT_EDITABLE' })
    expect(
      patchArtifactText({ block: 'b1', html: source, id: 'b1.99', shape: [], edits: [] }),
    ).toEqual({ ok: false, refusal: 'NO_ELEMENT' })
  })

  it('refuses a clone of the adoption agency and text the parser moved (foster parenting)', () => {
    // <b> crosses <p>: the parser clones it, the id names two elements.
    const misnested = '<b>один<p>два</b>три</p>'
    const stamped = stampArtifactHtml('m', misnested)
    const clones = ids(stamped).filter((id, at, all) => all.indexOf(id) !== at)
    expect(clones).toEqual([])
    const tree = parseFragment(stamped)
    const html = JSON.stringify(tree, (key, value) => (key === 'parentNode' ? undefined : value))
    expect((html.match(/"m\.1"/g) ?? []).length).toBe(2)
    expect(
      patchArtifactText({
        block: 'm',
        html: misnested,
        id: 'm.1',
        shape: [],
        edits: [{ slot: 0, text: 'x' }],
      }),
    ).toEqual({
      ok: false,
      refusal: 'AMBIGUOUS_ID',
    })
    // Text inside a table but outside a cell is moved before the table by the parser.
    const fostered = '<table>вне<tr><td>ячейка</td></tr></table>'
    const refusal = patchArtifactText({
      block: 'f',
      html: fostered,
      id: 'f.1',
      shape: ['tbody#'],
      edits: [{ slot: 0, text: 'x' }],
    })
    expect(refusal.ok).toBe(false)
  })
})

describe('the copy of the edit frame', () => {
  it('leads nowhere: links, SVG and MathML links, base, refresh, forms', () => {
    const copy = artifactEditCopy(
      '<base href="https://evil.example/" target="_top"><meta http-equiv="refresh" content="0;url=https://evil.example">' +
        '<a href="https://example.com" target="_blank" ping="https://p.example" download>a</a>' +
        '<svg><a xlink:href="https://evil.example"><text>s</text></a></svg>' +
        '<math><mi href="https://evil.example">m</mi></math><form action="https://evil.example"><button>b</button></form>',
    )
    expect(copy).not.toMatch(/evil\.example|example\.com|target=|ping=|download/)
    expect(copy).toContain('href="#raditi-no-link"')
  })
})

describe('import of whole files (§7.5)', () => {
  it('cuts an HTML document into styles, scripts and parts, dropping what loads from the web', () => {
    const parts = artifactHtmlParts(
      '<!doctype html><html><head><style>h1{color:red}</style><script src="https://cdn.example/x.js"></script>' +
        '<link rel="stylesheet" href="https://fonts.example/a.css"></head><body><header>Шапка</header>' +
        '<main>Текст</main><script>document.title="x"</script></body></html>',
      16,
    )
    expect(parts).toEqual({
      style: ['h1{color:red}'],
      script: ['document.title="x"'],
      html: ['<header>Шапка</header>', '<main>Текст</main>'],
    })
    expect(artifactSvgPart('<?xml version="1.0"?><svg></svg>')).toContain('<svg></svg>')
  })

  it('cuts Markdown at its second-level headings, outside fences', () => {
    expect(
      markdownImportSections(
        '# План\n\nВступление\n\n## Цель\n\nПродажи\n\n```\n## не раздел\n```\n\n## Каналы\n\n- сайт',
      ),
    ).toEqual({
      title: 'План',
      sections: [
        { heading: 'План', content: 'Вступление\n' },
        { heading: 'Цель', content: 'Продажи\n\n```\n## не раздел\n```\n' },
        { heading: 'Каналы', content: '- сайт\n' },
      ],
    })
  })
})

describe('artifactImportOf', () => {
  const bounds = { blockBytes: 32 * 1024, blocks: 200 }
  it('reads a page as a canvas of one screen, its parts inside the screen (plan 93, АТ6)', async () => {
    const { artifactImportOf } = await import('./import.ts')
    const page = artifactImportOf(
      'landing.html',
      '<html><head><title>Кофейня</title><style>h1{color:red}</style></head><body><h1>Кофе</h1><script>var x = 1</script></body></html>',
      bounds,
    )
    expect(page).toMatchObject({ ok: true, kind: 'canvas', title: 'Кофейня' })
    if (!page.ok) return
    expect(page.blocks[0]).toEqual({
      kind: 'frame',
      key: 'home',
      content: '',
      props: { name: 'Главная', path: '/', x: 0, y: 0 },
    })
    expect(page.blocks.slice(1).map((block) => [block.kind, block.parent])).toEqual([
      ['style', 'home'],
      ['html', 'home'],
      ['script', 'home'],
    ])
    const picture = artifactImportOf(
      'logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      bounds,
    )
    expect(picture).toMatchObject({ ok: true, kind: 'canvas' })
  })

  it('reads no CSV, and no file of another type', async () => {
    const { artifactImportOf } = await import('./import.ts')
    expect(artifactImportOf('price.csv', 'a;b\n1;2', bounds)).toEqual({
      ok: false,
      problem: 'type',
    })
    expect(artifactImportOf('a.docx', 'x', bounds)).toEqual({ ok: false, problem: 'type' })
    expect(artifactImportOf('a.md', '   ', bounds)).toEqual({ ok: false, problem: 'empty' })
  })
})

describe('the element a note anchors to (88.18е)', () => {
  const html = '<section><h2>Цены</h2><p>Хлеб <b>120 ₽</b></p><script>var x = 1</script></section>'
  const ids = (source: string) =>
    [...stampArtifactHtml('b1', source).matchAll(/data-rid="([^"]+)"/gu)].map((m) => m[1]!)

  it('reads the tag and the text inside from the source, by the id the server stamps', () => {
    const [section, h2, p] = ids(html)
    expect(artifactElementOf({ block: 'b1', html, id: h2! })).toEqual({ tag: 'h2', text: 'Цены' })
    expect(artifactElementOf({ block: 'b1', html, id: p! })).toEqual({
      tag: 'p',
      text: 'Хлеб  120 ₽',
    })
    // Raw text inside is never read.
    expect(artifactElementOf({ block: 'b1', html, id: section! })?.text).not.toContain('var x')
  })

  it('names nothing for an id of another block, a gone element or one inside a script', () => {
    const [, , , , script] = ids(html)
    expect(artifactElementOf({ block: 'b2', html, id: 'b1.2' })).toBeNull()
    expect(artifactElementOf({ block: 'b1', html, id: 'b1.99' })).toBeNull()
    expect(artifactElementOf({ block: 'b1', html, id: script! })).toBeNull()
  })
})
