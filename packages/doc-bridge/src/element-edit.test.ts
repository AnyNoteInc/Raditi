import { describe, expect, it } from 'vitest'

import {
  artifactElementOf,
  artifactElementSource,
  artifactHtmlEditRisk,
  replaceArtifactElements,
} from './html.ts'

// The source of an element of a canvas and its replacement (docs/plan/98-quick-edits.md, stage 4).

const html =
  '<section class="hero">\n  <h1>Кофе с собой</h1>\n  <p>Работаем с <b>8:00</b> до 20:00</p>\n</section>\n<footer><p>Адрес</p></footer>'

describe('the source of an element', () => {
  it('cuts the stored source of the element the id names, without the stamp', () => {
    // The ids by the order of start tags: section 1, h1 2, p 3, b 4, footer 5, p 6.
    expect(artifactElementSource({ block: 'hero', html, id: 'hero.3' })).toMatchObject({
      source: '<p>Работаем с <b>8:00</b> до 20:00</p>',
      tag: 'p',
    })
    const outer = artifactElementSource({ block: 'hero', html, id: 'hero.1' })
    expect(outer?.source.startsWith('<section class="hero">')).toBe(true)
    expect(outer?.source.endsWith('</section>')).toBe(true)
  })

  it('reads the same element as the anchor of a note does', () => {
    const anchor = artifactElementOf({ block: 'hero', html, id: 'hero.2' })
    expect(artifactElementSource({ block: 'hero', html, id: 'hero.2' })).toMatchObject(anchor!)
  })

  it('keeps the offsets right where the source has its own data-rid', () => {
    const own = '<div data-rid="old.7"><p>Текст</p></div>'
    expect(artifactElementSource({ block: 'b', html: own, id: 'b.2' })?.source).toBe('<p>Текст</p>')
  })

  it('finds nothing by an id of another block, a missing one, or inside raw text', () => {
    expect(artifactElementSource({ block: 'hero', html, id: 'other.1' })).toBeNull()
    expect(artifactElementSource({ block: 'hero', html, id: 'hero.99' })).toBeNull()
    expect(
      artifactElementSource({ block: 'b', html: '<script>var a = 1</script>', id: 'b.1' }),
    ).toBeNull()
  })
})

describe('the replacement of elements', () => {
  it('puts each new source in place of the one read, the rest byte for byte', () => {
    const h1 = artifactElementSource({ block: 'hero', html, id: 'hero.2' })!
    const p = artifactElementSource({ block: 'hero', html, id: 'hero.6' })!
    const result = replaceArtifactElements({
      block: 'hero',
      html,
      replacements: [
        { id: h1.id, source: h1.source, to: '<h1>Кофе навынос</h1>' },
        { id: p.id, source: p.source, to: '<p>Адрес: Ленина, 1</p>' },
      ],
    })
    expect(result).toEqual({
      ok: true,
      html: html
        .replace('Кофе с собой', 'Кофе навынос')
        .replace('<p>Адрес</p>', '<p>Адрес: Ленина, 1</p>'),
    })
  })

  it('refuses a source changed meanwhile, a gone element, and two that overlap', () => {
    const p = artifactElementSource({ block: 'hero', html, id: 'hero.3' })!
    const b = artifactElementSource({ block: 'hero', html, id: 'hero.4' })!
    expect(
      replaceArtifactElements({
        block: 'hero',
        html,
        replacements: [{ id: p.id, source: '<p>другой</p>', to: 'x' }],
      }),
    ).toEqual({ ok: false, refusal: 'CHANGED' })
    expect(
      replaceArtifactElements({
        block: 'hero',
        html,
        replacements: [{ id: 'hero.99', source: '', to: 'x' }],
      }),
    ).toEqual({ ok: false, refusal: 'NO_ELEMENT' })
    expect(
      replaceArtifactElements({
        block: 'hero',
        html,
        replacements: [
          { id: p.id, source: p.source, to: '<p>a</p>' },
          { id: b.id, source: b.source, to: '<b>9:00</b>' },
        ],
      }),
    ).toEqual({ ok: false, refusal: 'OVERLAP' })
  })

  it('refuses a new source that is not exactly one element', () => {
    const h1 = artifactElementSource({ block: 'hero', html, id: 'hero.2' })!
    for (const to of ['<h1>Кофе</h1><p>ещё</p>', 'Кофе', '<h1>Кофе'])
      expect(
        replaceArtifactElements({
          block: 'hero',
          html,
          replacements: [{ id: h1.id, source: h1.source, to }],
        }),
      ).toEqual({ ok: false, refusal: 'NOT_ONE_ELEMENT' })
  })
})

describe('what the parser would hide (review of stage 4)', () => {
  const one = (block: string, source: string, id: string, to: string) => {
    const found = artifactElementSource({ block, html: source, id })!
    return replaceArtifactElements({
      block,
      html: source,
      replacements: [{ id, source: found.source, to }],
    })
  }

  it('refuses a tag left open that would spread into the elements after it', () => {
    const block = '<div><p>Hi</p></div><section><p>later</p><p>more</p></section>'
    expect(one('b', block, 'b.2', '<p><b>Hi</p>')).toEqual({ ok: false, refusal: 'SPILLS' })
    const link = '<p>one <a href="/a">link</a></p><p>two</p>'
    expect(one('b', link, 'b.1', '<p>one <a href="/a">link</p>')).toMatchObject({ ok: false })
  })

  it('refuses dropping the end tag of an outer element the source of the part held', () => {
    const block = '<b><p>x</b>y</p><p>after</p>'
    const found = artifactElementSource({ block: 'b', html: block, id: 'b.2' })
    if (found === null) return
    expect(one('b', block, 'b.2', '<p>x y</p>')).toMatchObject({ ok: false })
  })

  it('places each part by its offsets, also where the parser moved content out of a table', () => {
    const block = '<table><tr><td>Cell</td></tr><p>Note</p></table>'
    const p = artifactElementSource({ block: 'b', html: block, id: 'b.1' })!
    const td = artifactElementSource({ block: 'b', html: block, id: 'b.4' })!
    expect(p.tag).toBe('p')
    expect(td.tag).toBe('td')
    expect(
      replaceArtifactElements({
        block: 'b',
        html: block,
        replacements: [
          { id: 'b.1', source: p.source, to: '<p>Note <b>new</b></p>' },
          { id: 'b.4', source: td.source, to: '<td>Cell 2</td>' },
        ],
      }),
    ).toEqual({ ok: true, html: '<table><tr><td>Cell 2</td></tr><p>Note <b>new</b></p></table>' })
  })
})

describe('what an edit of an element may bring', () => {
  const risk = (after: string, before = '<p>Цена 100</p>', allowed = '') =>
    artifactHtmlEditRisk({ before, after, allowed })

  it('lets text and simple markup change', () => {
    expect(risk('<p>Цена <b>200</b> ₽</p>')).toBeNull()
  })

  it('reads attributes as a browser does: no event handler or script scheme slips through', () => {
    for (const after of [
      '<p>Цена 200<img/onerror=alert(1) src=x></p>',
      '<p title="a"onclick="alert(1)">Цена</p>',
      '<p><a href="javascript&colon;alert(1)">Цена</a></p>',
      '<p><a href="java&#x09;script:alert(1)">Цена</a></p>',
      '<p><A HREF="JavaScript:alert(1)">Цена</A></p>',
      '<p><iframe srcdoc="<script>x()</script>"></iframe></p>',
      '<p><svg><a xlink:href="javascript:x()">Цена</a></svg></p>',
      '<p style="background:url(https://e.example/x)">Цена</p>',
      '<p><img src="data:image/svg+xml,<svg onload=x()>"></p>',
    ])
      expect(risk(after)?.kind).toBe('active')
  })

  it('refuses a new address, also protocol-relative or entity-encoded, unless the client gave it', () => {
    expect(risk('<p><a href="//evil.example/x">Цена</a></p>')).toEqual({
      kind: 'address',
      detail: 'evil.example/x',
    })
    expect(risk('<p><a href="https&#58;//evil.example">Цена</a></p>')?.kind).toBe('address')
    expect(
      risk('<p><a href="https://shop.ru/menu">Цена</a></p>', '<p>Цена</p>', 'ссылку shop.ru/menu'),
    ).toBeNull()
    expect(
      risk('<p><a href="tel:+79001234567">Цена</a></p>', '<p><a href="tel:+79001234567">Ц</a></p>'),
    ).toBeNull()
  })

  it('keeps what the element already had', () => {
    const own = '<p onclick="go()"><a href="https://shop.ru">Заказ</a></p>'
    expect(risk('<p onclick="go()"><a href="https://shop.ru">Заказать</a></p>', own)).toBeNull()
  })
})
