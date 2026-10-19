import { describe, expect, it } from 'vitest'

import { scrubNestedSecrets } from './nested-secrets.ts'

// Secrets inside copied values (plan 53, Р14, Р15): the string under a secret key of a serialized
// or JSON value is blanked, at any depth; nothing else of the value changes.

const scrub = (text: string) => scrubNestedSecrets(Buffer.from(text, 'utf8')).toString('utf8')
/** `s:<bytes>:"text";` as PHP writes it: the length in bytes of UTF-8. */
const s = (text: string) => `s:${Buffer.byteLength(text)}:"${text}";`

describe('secrets nested in copied values', () => {
  it('blanks the secrets of a serialized widget and keeps every other byte', () => {
    const widget =
      'a:2:{i:2;a:4:{' +
      `${s('title')}${s('Подпишитесь')}` +
      `${s('api_key')}${s('us7-0123456789abcdef')}` +
      `${s('consumer_secret')}${s('Zq"};s:3:"x";')}` +
      `${s('count')}i:5;` +
      `}${s('_multiwidget')}i:1;}`
    expect(scrub(widget)).toBe(
      'a:2:{i:2;a:4:{' +
        `${s('title')}${s('Подпишитесь')}` +
        `${s('api_key')}s:0:"";` +
        `${s('consumer_secret')}s:0:"";` +
        `${s('count')}i:5;` +
        `}${s('_multiwidget')}i:1;}`,
    )
  })

  it('blanks a list under a secret key, an object, and a value serialized inside a string', () => {
    const inner = `a:1:{${s('webhook_url')}${s('https://hooks.example.test/T0K3N')}}`
    const theme =
      'a:3:{' +
      `${s('license_keys')}a:2:{i:0;${s('k-1')}i:1;${s('k-2')}}` +
      `${s('map')}O:8:"stdClass":1:{${s('google_maps_api_key')}${s('AIza-123')}}` +
      `${s('nested')}${s(inner)}` +
      '}'
    const blankInner = `a:1:{${s('webhook_url')}s:0:"";}`
    expect(scrub(theme)).toBe(
      'a:3:{' +
        `${s('license_keys')}a:2:{i:0;s:0:"";i:1;s:0:"";}` +
        `${s('map')}O:8:"stdClass":1:{${s('google_maps_api_key')}s:0:"";}` +
        `${s('nested')}${s(blankInner)}` +
        '}',
    )
  })

  it('blanks the secrets of page builder data in JSON, spelled as it was stored', () => {
    const elementor =
      '[{"id":"a1","elType":"widget","settings":{"form_name":"Заявка",' +
      '"mailchimp_api_key":"0123-us7","submit_actions":["email","webhook"],' +
      '"webhooks":"https:\\/\\/hooks.example.test\\/abc","nested":{"activecampaign_api_key":"x\\"y"}},' +
      '"elements":[]}]'
    expect(scrub(elementor)).toBe(
      '[{"id":"a1","elType":"widget","settings":{"form_name":"Заявка",' +
        '"mailchimp_api_key":"","submit_actions":["email","webhook"],' +
        '"webhooks":"","nested":{"activecampaign_api_key":""}},' +
        '"elements":[]}]',
    )
  })

  it('copies as it is what is neither, or does not parse whole', () => {
    for (const text of [
      'обычный текст с api_key внутри',
      '42',
      `a:1:{${s('api_key')}${s('x')}`,
      's:5:"abc";',
      '{"api_key": "x"',
      '{"api_key": "x"} trailing',
      'C:3:"Foo":5:{12345}',
      '',
    ])
      expect(scrub(text), text).toBe(text)
    // Bytes that are not UTF-8 survive: the value is read byte for byte.
    const latin = Buffer.from([0x61, 0xe9, 0xff, 0x00, 0x62])
    expect(scrubNestedSecrets(latin)).toEqual(latin)
  })

  it('stops following a value deeper than it reads', () => {
    const deep = `${'a:1:{i:0;'.repeat(80)}${s('x')}${'}'.repeat(80)}`
    expect(scrub(deep)).toBe(deep)
  })
})
