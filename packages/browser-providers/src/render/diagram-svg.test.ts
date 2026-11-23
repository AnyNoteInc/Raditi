import { describe, expect, it } from 'vitest'

import { cleanDiagramSvg } from './diagram-svg.ts'

// The cleaning of an SVG Mermaid drew (docs/plan/88-artifacts.md, §7.13, 88.24а; spike 7).

const svg = (inner: string, attrs = 'viewBox="0 0 120.4 60" style="max-width: 120px;"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`

describe('a diagram cleaned for <img>', () => {
  it('keeps the picture as XML, sized by its viewBox', () => {
    const clean = cleanDiagramSvg(
      svg('<g><rect width="10" height="10"/><text>Заказ<tspan>&amp;</tspan></text></g>'),
    )
    expect(clean).toMatchObject({ width: 121, height: 60 })
    expect(clean!.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(clean!.svg).toContain('width="121"')
    expect(clean!.svg).not.toContain('max-width')
    expect(clean!.svg).toContain('&amp;')
  })

  it('gives SVG names their capitals back: a lost feDropShadow hides every node', () => {
    const clean = cleanDiagramSvg(
      svg(
        '<defs><filter id="s"><feDropShadow dx="1" dy="1"/></filter></defs><rect filter="url(#s)"/>',
      ),
    )
    expect(clean!.svg).toContain('<feDropShadow')
    expect(clean!.svg).toContain('filter="url(#s)"')
  })

  it('takes out scripts, handlers, links away and CSS that loads from the network', () => {
    const clean = cleanDiagramSvg(
      svg(
        [
          '<script>alert(1)</script>',
          '<rect onclick="alert(1)" width="1" height="1"/>',
          '<a href="javascript:alert(1)"><text>x</text></a>',
          '<use href="https://attacker.example/s.svg#a"/>',
          '<style>@import url("https://attacker.example/a.css?x=1;y=2"); .n{fill:url(https://attacker.example/p.png)} .m{fill:url(#ok)}</style>',
          '<rect style="fill:url(//attacker.example/q.png)"/>',
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x"/></div></foreignObject>',
        ].join(''),
      ),
    )!.svg
    expect(clean).not.toMatch(
      /script|onclick|javascript:|attacker\.example|@import|foreignObject|<img/i,
    )
    expect(clean).toContain('url(#ok)')
  })

  it('refuses what has no SVG or no size to show', () => {
    expect(cleanDiagramSvg('<div>нет</div>')).toBeNull()
    expect(cleanDiagramSvg(svg('<rect/>', ''))).toBeNull()
    expect(cleanDiagramSvg(svg('<rect/>', 'viewBox="0 0 0 10"'))).toBeNull()
  })
})
