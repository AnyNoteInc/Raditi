import { siteImportLimits } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { phpConfigStrings, phpStringsAfter, secretValues } from './php-config.ts'

const encoder = new TextEncoder()
const php = (text: string) => encoder.encode(text)
const before = /KEY = /
const after = /;/
const values = (text: string) => phpStringsAfter(php(text), before, after)
const char = (code: number) => String.fromCharCode(code)
/** The JSON escape of `A`, six characters; joined here so that no tool reads it as the letter. */
const jsonEscape = ['\\', 'u0041'].join('')

describe('phpStringsAfter', () => {
  it.each([
    [`KEY = 'plain';`, 'plain'],
    [String.raw`KEY = 'it\'s';`, "it's"],
    [String.raw`KEY = 'back\\slash';`, 'back\\slash'],
    [String.raw`KEY = 'ends with one\\';`, 'ends with one\\'],
    [`KEY = 'a"b';`, 'a"b'],
    // Single quotes undo nothing else: the backslash stays in the value.
    [String.raw`KEY = 'kept\n\x41\$\"';`, String.raw`kept\n\x41\$\"`],
    [`KEY = 'user$name {$x} \${y}';`, 'user$name {$x} ${y}'],
    [`KEY = 'пароль';`, 'пароль'],
    [`KEY = '';`, ''],
  ])('reads the single-quoted literal of %s', (text, value) => {
    expect(values(text)).toEqual([value])
  })

  it.each([
    [`KEY = "plain";`, 'plain'],
    [String.raw`KEY = "q\"q";`, 'q"q'],
    [String.raw`KEY = "d\$d";`, 'd$d'],
    [String.raw`KEY = "b\\b";`, 'b\\b'],
    [String.raw`KEY = "ends with one\\";`, 'ends with one\\'],
    [`KEY = "it's";`, "it's"],
    [String.raw`KEY = "t\tn\nr\rv\ve\ef\f";`, `t\tn\nr\rv${char(11)}e${char(27)}f${char(12)}`],
    [String.raw`KEY = "\101\x42\u{43}\x4a\X4b\12";`, 'ABCJK\n'],
    // One or two hexadecimal digits, never three.
    [String.raw`KEY = "\x417\x9.";`, 'A7\t.'],
    // PHP keeps the low byte of an octal escape.
    [String.raw`KEY = "\400\477";`, `${char(0)}?`],
    // Bytes written one escape each are one character of the value.
    [String.raw`KEY = "\xD0\x9F\320\237";`, 'ПП'],
    [String.raw`KEY = "\u{41f}\u{1F600}";`, 'П😀'],
    // What is no escape of double quotes stays as it is written.
    [String.raw`KEY = "kept\q\'\xZZ\8\ ";`, String.raw`kept\q\'\xZZ\8\ `],
    [`KEY = "json ${jsonEscape}";`, `json ${jsonEscape}`],
    // The character behind such a backslash starts nothing: no variable follows `{$` here.
    [String.raw`KEY = "a\{b\{$";`, String.raw`a\{b\{$`],
    [`KEY = "100$ and $1 and a$";`, '100$ and $1 and a$'],
    [`KEY = "a { b } {";`, 'a { b } {'],
  ])('reads the double-quoted literal of %s', (text, value) => {
    expect(values(text)).toEqual([value])
  })

  it.each([
    // A variable: the value is not in the file.
    `KEY = "user$name";`,
    `KEY = "a$_b";`,
    `KEY = "a\${x}";`,
    `KEY = "a{$x}";`,
    `KEY = "a{$}";`,
    `KEY = "{$ x}";`,
    `KEY = "a$пароль";`,
    String.raw`KEY = "\{$x}";`,
    // Not a string PHP accepts, or not text.
    String.raw`KEY = "\u{110000}";`,
    String.raw`KEY = "\u{}";`,
    String.raw`KEY = "\u{4g}";`,
    String.raw`KEY = "\u{ 41}";`,
    String.raw`KEY = "\u{41";`,
    String.raw`KEY = "\u{D800}";`,
    String.raw`KEY = "\xFF";`,
    // Not one constant literal.
    `KEY = 'never ends`,
    `KEY = "never ends\\`,
    `KEY = getenv('KEY');`,
    `KEY = $other;`,
    `KEY = <<<EOT\nvalue\nEOT;`,
    `KEY = 'a' . 'b';`,
    `KEY = 'a' . $b;`,
    `KEY = 12345;`,
    `KEY = `,
  ])('reads no value from %s', (text) => {
    expect(values(text)).toEqual([])
  })

  it('reads no value whose bytes are not UTF-8', () => {
    // «пароль» in windows-1251.
    const file = Uint8Array.of(...php(`KEY = '`), 0xef, 0xe0, 0xf0, 0xee, 0xeb, 0xfc, ...php(`';`))
    expect(phpStringsAfter(file, before, after)).toEqual([])
    // The rest of such a file is still read.
    expect(
      phpStringsAfter(Uint8Array.of(...file, ...php(` KEY = 'ascii';`)), before, after),
    ).toEqual(['ascii'])
  })

  it('keeps a byte order mark that a value begins with', () => {
    // EF BB BF behind the quote are three bytes of the value to PHP, and of the text to search for.
    const marked = `${char(0xfeff)}abc`
    const file = Uint8Array.of(...php(`KEY = '`), 0xef, 0xbb, 0xbf, ...php(`abc';`))
    expect(phpStringsAfter(file, before, after)).toEqual([marked])
    expect(values(String.raw`KEY = "\xEF\xBB\xBFabc";`)).toEqual([marked])
    expect(values(String.raw`KEY = "\u{FEFF}abc";`)).toEqual([marked])
    // Four characters with the mark: a value worth the search.
    expect(secretValues(phpStringsAfter(file, before, after))).toEqual([marked])
  })

  it('reads a literal of up to 4096 bytes between its quotes and none that is longer', () => {
    for (const quote of [`'`, `"`]) {
      const literal = (bytes: number) => `KEY = ${quote}${'x'.repeat(bytes)}${quote};`
      expect(values(literal(4096))).toEqual(['x'.repeat(4096)])
      expect(values(literal(4097))).toEqual([])
      // The bound is about the source: an escape counts with every byte it is written in.
      expect(values(literal(4095).replace('xx', String.raw`\\`))).toEqual([`\\${'x'.repeat(4093)}`])
      expect(values(literal(4096).replace('x', String.raw`\\`))).toEqual([])
      // A literal that never closes hides nothing behind it.
      expect(values(`KEY = ${quote}${'x'.repeat(5000)} KEY = 'found';`)).toEqual(['found'])
    }
  })

  it('returns every value in the order of the file, repeated ones included', () => {
    expect(values(`KEY = 'one'; // KEY = 'two';\nKEY = "three";KEY = 'one';`)).toEqual([
      'one',
      'two',
      'three',
      'one',
    ])
  })

  it('wants the literal right behind the first pattern and right in front of the second', () => {
    expect(values(`KEY =  'two spaces';`)).toEqual([])
    expect(values(`KEY = 'space' ;`)).toEqual([])
    expect(
      phpStringsAfter(php(`KEY =\t\n'v' \r\n;`), /KEY[ \t\r\n]*=[ \t\r\n]*/, /[ \t\r\n]*;/),
    ).toEqual(['v'])
  })

  it('keeps the letter-case flag of the first pattern and no state of either', () => {
    const sticky = /key = /giy
    sticky.lastIndex = 40
    const tail = /;/g
    tail.lastIndex = 40
    const text = `Key = 'a'; KEY = 'b';`
    expect(phpStringsAfter(php(text), sticky, tail)).toEqual(['a', 'b'])
    expect(phpStringsAfter(php(text), /key = /, tail)).toEqual([])
    expect([sticky.lastIndex, tail.lastIndex]).toEqual([40, 40])
  })

  it('reads a file of the largest size that is offered', () => {
    const last = `KEY = 'at the end';`
    const text = `${' '.repeat(8185)}KEY = 'across two chunks of the conversion';`
    const file = php(text.padEnd(siteImportLimits.configFileBytes - last.length, ' ') + last)
    expect(file.byteLength).toBe(siteImportLimits.configFileBytes)
    expect(phpStringsAfter(file, before, after)).toEqual([
      'across two chunks of the conversion',
      'at the end',
    ])
  })
})

describe('phpConfigStrings', () => {
  it('asks the reader for the one path and reads the file it gets', async () => {
    const asked: string[] = []
    const read = async (path: string) => {
      asked.push(path)
      return php(`KEY = 'value';`)
    }
    expect(await phpConfigStrings(read, 'dir/config.php', before, after)).toEqual(['value'])
    expect(asked).toEqual(['dir/config.php'])
  })

  it('has nothing to say about a file the reader does not have', async () => {
    expect(await phpConfigStrings(async () => null, 'config.php', before, after)).toEqual([])
  })

  it('does not search a file above the limit, whatever the reader lets through', async () => {
    const text = `KEY = 'value';`
    const atLimit = php(text.padEnd(siteImportLimits.configFileBytes, ' '))
    const above = php(text.padEnd(siteImportLimits.configFileBytes + 1, ' '))
    expect(await phpConfigStrings(async () => atLimit, 'config.php', before, after)).toEqual([
      'value',
    ])
    expect(await phpConfigStrings(async () => above, 'config.php', before, after)).toEqual([])
  })

  it('lets a failure of the reader through', async () => {
    const read = async () => {
      throw new Error('connection lost')
    }
    await expect(phpConfigStrings(read, 'config.php', before, after)).rejects.toThrow(
      'connection lost',
    )
  })
})

describe('secretValues', () => {
  it('keeps each value once, in the order it was first seen', () => {
    expect(secretValues(['second', 'first', 'second', 'third', 'first'])).toEqual([
      'second',
      'first',
      'third',
    ])
  })

  it('drops a value shorter than four characters', () => {
    expect(secretValues(['', 'a', 'abc', 'abcd', 'абв', 'абвг', '😀😀😀', '😀😀😀😀'])).toEqual([
      'abcd',
      'абвг',
      '😀😀😀😀',
    ])
  })
})
