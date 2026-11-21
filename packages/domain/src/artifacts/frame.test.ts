import { describe, expect, it } from 'vitest'

import {
  ARTIFACT_BRIDGE,
  ARTIFACT_SANDBOX,
  artifactBridgeMessageSchema,
  artifactEditFrameHeaders,
  artifactFileRefsOf,
  artifactFramePolicy,
  artifactFrameDocument,
  artifactImportKindOf,
  artifactPlatformFileHeaders,
  artifactSettingsFields,
  checkArtifactFile,
  readArtifactPlatformToken,
  withArtifactFileAddresses,
} from './frame.ts'

const id = '01960000-0000-7000-8000-0000000000a1'

describe('the frame of an artifact (Ар28)', () => {
  it('has no pop-ups, no network and names each file exactly', () => {
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts')
    const policy = artifactFramePolicy('https://raditi.ru', {
      scripts: [],
      styles: [],
      images: ['https://pages.raditi.ru/v/a.b'],
      fonts: ['https://pages.raditi.ru/v/lib-golos-cyr.0123456789abcdef'],
    })
    expect(policy.split('; ')[0]).toBe('sandbox allow-scripts')
    expect(policy).not.toMatch(/allow-popups|allow-same-origin|'self'|https:(?!\/\/)/)
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain('img-src data: blob: https://pages.raditi.ru/v/a.b')
    expect(policy).toContain('frame-ancestors https://raditi.ru')
  })

  it('the edit frame runs no script and is framed by the cabinet only (Ар9)', () => {
    const headers = artifactEditFrameHeaders('https://pages.raditi.ru')
    expect(headers['Content-Security-Policy']).toMatch(/^sandbox allow-same-origin; /)
    expect(headers['Content-Security-Policy']).toContain("script-src 'none'")
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'self'")
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN')
  })

  it('a file of the platform is immutable and loads into any frame (spike 2)', () => {
    expect(artifactPlatformFileHeaders('font/woff2')).toMatchObject({
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    expect(readArtifactPlatformToken('lib-golos-cyr.0123456789abcdef')).toEqual({
      label: 'lib-golos-cyr',
      hash: '0123456789abcdef',
    })
    expect(readArtifactPlatformToken('eyJhIjoiMSJ9.c2ln')).toBeNull()
  })
})

describe('the files of an artifact (Ар12)', () => {
  it('are named by references, given addresses at the time of serving', () => {
    const text = `<img src="artifact-file:${id}"><div style="background:url(artifact-file:${id})">`
    expect(artifactFileRefsOf(text)).toEqual([id])
    expect(withArtifactFileAddresses(text, () => 'https://p/v/t')).toBe(
      '<img src="https://p/v/t"><div style="background:url(https://p/v/t)">',
    )
    expect(withArtifactFileAddresses(text, () => null)).toContain('about:blank')
  })

  it('are pictures and fonts that begin as their type does', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    expect(checkArtifactFile('logo.png', png)).toEqual({ ok: true, type: 'image/png' })
    expect(checkArtifactFile('logo.jpg', png)).toEqual({ ok: false, reason: 'signature' })
    expect(checkArtifactFile('page.html', png)).toEqual({ ok: false, reason: 'type' })
  })
})

describe('the bridge (Ар29)', () => {
  it('takes only its own messages of the white list', () => {
    expect(
      artifactBridgeMessageSchema.safeParse({ bridge: ARTIFACT_BRIDGE, type: 'ready' }).success,
    ).toBe(true)
    expect(
      artifactBridgeMessageSchema.safeParse({
        bridge: ARTIFACT_BRIDGE,
        type: 'link',
        href: 'javascript:alert(1)',
      }).success,
    ).toBe(false)
    expect(
      artifactBridgeMessageSchema.safeParse({
        bridge: ARTIFACT_BRIDGE,
        type: 'size',
        height: 10,
        width: 390,
        x: 1,
      }).success,
    ).toBe(false)
    expect(artifactBridgeMessageSchema.safeParse({ type: 'ready' }).success).toBe(false)
  })
})

describe('the document of a frame', () => {
  it('puts the styles in its head, the settings as JSON and the scripts after the bridge', () => {
    const html = artifactFrameDocument({
      title: 'Калькулятор <1>',
      platformCss: '@font-face{}',
      bridge: true,
      parts: {
        html: ['<main>Цена</main>'],
        style: ['main{color:red}</style><script>x</script>'],
        script: ['console.log("</script>")'],
        settings: '{"note":"</script><b>"}',
      },
    })
    expect(html).toContain('<title>Калькулятор &lt;1&gt;</title>')
    expect(html).not.toContain('</style><script>x')
    expect(html).toContain(
      '<script type="application/json" id="raditi-settings">{"note":"\\u003c/script>\\u003cb>"}</script>',
    )
    expect(html.indexOf(ARTIFACT_BRIDGE)).toBeLessThan(html.indexOf('console.log'))
    expect(html).toContain('console.log("<\\/script>")')
  })

  it('without the bridge and scripts is the edit frame', () => {
    const html = artifactFrameDocument({
      title: 'x',
      platformCss: '',
      bridge: false,
      parts: { html: ['<p>a</p>'], style: [], script: [], settings: null },
    })
    expect(html).not.toContain('<script')
  })
})

describe('the settings of a mockup (Ар9)', () => {
  it('give the form their scalars at the top level', () => {
    expect(artifactSettingsFields('{"price":1200,"title":"Окна","dark":false,"list":[1]}')).toEqual(
      [
        { key: 'price', value: 1200 },
        { key: 'title', value: 'Окна' },
        { key: 'dark', value: false },
      ],
    )
    expect(artifactSettingsFields('[1]')).toBeNull()
  })
})

describe('import kinds', () => {
  it('follow the extension', () => {
    expect(artifactImportKindOf('a.MD')).toBe('document')
    expect(artifactImportKindOf('a.svg')).toBe('mockup')
    expect(artifactImportKindOf('a.csv')).toBe('table')
    expect(artifactImportKindOf('a.txt')).toBeNull()
  })
})
