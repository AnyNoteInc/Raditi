// Secrets inside copied values (docs/plan/53-chat-preview-release.md, Р14, Р15): a value the copy
// policy keeps — the data of a page builder, the settings of a widget or a theme — may hold a key
// of its own whose name says it is a secret (a form's `mailchimp_api_key`, a widget's
// `consumer_secret`, a webhook with its token). The treatment `scrub_secrets` of a column blanks
// the string under every such key of a value in PHP's serialization or in JSON, at any depth, and
// leaves every other byte as it was. A value that is neither, or that does not parse whole, is
// copied as it is: the copy never guesses at bytes it cannot read.
//
// The value is handled as Latin-1 — one character per byte — so the lengths of PHP's strings stay
// byte lengths whatever the encoding of the connection, and nothing outside a blanked string
// changes.

/** A key whose value is a secret: a key, a token, a password, a secret, a webhook. */
const SECRET_KEY =
  /api[_-]?key|apikey|secret|passw(?:or)?d|pwd|token|private[_-]?key|access[_-]?key|license[_-]?key|webhook|auth[_-]?key/i
/** How deep a value is followed: deeper and it is copied as it is. */
const MAX_DEPTH = 64

const isSecretKey = (key: string | null): boolean => key !== null && SECRET_KEY.test(key)

class Unreadable extends Error {}

/** PHP's serialization (`serialize()`), the subset WordPress stores. */
class Serialized {
  #at = 0
  readonly #out: string[] = []

  readonly text: string

  constructor(text: string) {
    this.text = text
  }

  /** The value with every secret under a secret key blanked; null — not a value of this form. */
  static scrub(text: string, depth: number): string | null {
    if (depth > MAX_DEPTH || !/^(?:[aOsibdNCE]:|N;)/.test(text)) return null
    try {
      const reader = new Serialized(text)
      reader.#value({ secret: false, key: false }, depth)
      return reader.#at === text.length ? reader.#out.join('') : null
    } catch (error) {
      if (error instanceof Unreadable) return null
      throw error
    }
  }

  #expect(literal: string): void {
    if (!this.text.startsWith(literal, this.#at)) throw new Unreadable()
    this.#at += literal.length
  }

  /** Digits up to `end`, copied. */
  #number(end: string, signed = false): number {
    const match = (signed ? /^-?\d{1,20}/ : /^\d{1,20}/).exec(
      this.text.slice(this.#at, this.#at + 22),
    )
    if (!match) throw new Unreadable()
    this.#at += match[0].length
    this.#expect(end)
    return Number(match[0])
  }

  /** `<length>:"<bytes>"` — the bytes of a string, read raw. */
  #bytes(): string {
    const length = this.#number(':')
    this.#expect('"')
    if (this.#at + length > this.text.length) throw new Unreadable()
    const bytes = this.text.slice(this.#at, this.#at + length)
    this.#at += length
    this.#expect('"')
    return bytes
  }

  /**
   * One value, copied or blanked; returns the bytes of a string or the digits of an integer (a
   * key of its array). `secret` — it stands under a secret key, or inside a value that does;
   * `key` — it is a key itself: never blanked, never read inside.
   */
  #value(at: { secret: boolean; key: boolean }, depth: number): string | null {
    if (depth > MAX_DEPTH) throw new Unreadable()
    const start = this.#at
    const type = this.text[this.#at]
    switch (type) {
      case 'N':
        this.#expect('N;')
        this.#out.push('N;')
        return null
      case 'b':
      case 'i':
      case 'r':
      case 'R': {
        this.#expect(`${type}:`)
        const value = this.#number(';', type === 'i')
        this.#out.push(this.text.slice(start, this.#at))
        return type === 'i' ? String(value) : null
      }
      case 'd': {
        this.#expect('d:')
        const end = this.text.indexOf(';', this.#at)
        if (
          end < 0 ||
          !/^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|NAN|-?INF)$/i.test(
            this.text.slice(this.#at, end),
          )
        )
          throw new Unreadable()
        this.#at = end + 1
        this.#out.push(this.text.slice(start, this.#at))
        return null
      }
      case 's':
      case 'E': {
        this.#expect(`${type}:`)
        const bytes = this.#bytes()
        this.#expect(';')
        if (type === 's' && at.secret && !at.key) this.#out.push('s:0:"";')
        else {
          // A string may hold a serialized value or JSON of its own: scrubbed too, its length
          // written anew.
          const inner = type === 's' && !at.key ? scrubNested(bytes, depth + 1) : bytes
          this.#out.push(`${type}:${inner.length}:"${inner}";`)
        }
        return bytes
      }
      case 'a': {
        this.#expect('a:')
        const count = this.#number(':')
        this.#expect('{')
        this.#out.push(`a:${count}:{`)
        this.#pairs(count, at.secret, depth)
        this.#expect('}')
        this.#out.push('}')
        return null
      }
      case 'O': {
        this.#expect('O:')
        const name = this.#bytes()
        this.#expect(':')
        const count = this.#number(':')
        this.#expect('{')
        this.#out.push(`O:${name.length}:"${name}":${count}:{`)
        this.#pairs(count, at.secret, depth)
        this.#expect('}')
        this.#out.push('}')
        return null
      }
      case 'C': {
        // A class that serializes itself: its payload is its own, copied as it is.
        this.#expect('C:')
        this.#bytes()
        this.#expect(':')
        const length = this.#number(':')
        this.#expect('{')
        if (this.#at + length > this.text.length) throw new Unreadable()
        this.#at += length
        this.#expect('}')
        this.#out.push(this.text.slice(start, this.#at))
        return null
      }
      default:
        throw new Unreadable()
    }
  }

  #pairs(count: number, secret: boolean, depth: number): void {
    for (let index = 0; index < count; index++) {
      const key = this.#value({ secret: false, key: true }, depth + 1)
      this.#value({ secret: secret || isSecretKey(key), key: false }, depth + 1)
    }
  }
}

/** JSON, as page builders store it: only the strings under secret keys change. */
class Json {
  #at = 0
  readonly #out: string[] = []

  readonly text: string

  constructor(text: string) {
    this.text = text
  }

  static scrub(text: string, depth: number): string | null {
    if (depth > MAX_DEPTH || !/^\s*[[{]/.test(text)) return null
    try {
      const reader = new Json(text)
      reader.#space()
      reader.#value(false, depth)
      reader.#space()
      return reader.#at === text.length ? reader.#out.join('') : null
    } catch (error) {
      if (error instanceof Unreadable) return null
      throw error
    }
  }

  #space(): void {
    const match = /^[ \t\r\n]*/.exec(this.text.slice(this.#at))!
    this.#out.push(match[0])
    this.#at += match[0].length
  }

  #punctuation(char: string): void {
    if (this.text[this.#at] !== char) throw new Unreadable()
    this.#at += 1
    this.#out.push(char)
  }

  /** A string token as it is written, quotes and escapes included. */
  #stringToken(): string {
    if (this.text[this.#at] !== '"') throw new Unreadable()
    let end = this.#at + 1
    for (;;) {
      const char = this.text[end]
      if (char === undefined || char < ' ') throw new Unreadable()
      if (char === '"') break
      end += char === '\\' ? 2 : 1
    }
    const token = this.text.slice(this.#at, end + 1)
    this.#at = end + 1
    return token
  }

  /** One value; `secret` — it stands under a secret key, or inside a value that does. */
  #value(secret: boolean, depth: number): void {
    if (depth > MAX_DEPTH) throw new Unreadable()
    const char = this.text[this.#at]
    if (char === '{') {
      this.#punctuation('{')
      this.#space()
      if (this.text[this.#at] === '}') return this.#punctuation('}')
      for (;;) {
        const token = this.#stringToken()
        this.#out.push(token)
        let name: string
        try {
          name = JSON.parse(token) as string
        } catch {
          throw new Unreadable()
        }
        this.#space()
        this.#punctuation(':')
        this.#space()
        this.#value(secret || isSecretKey(name), depth + 1)
        this.#space()
        if (this.text[this.#at] === '}') return this.#punctuation('}')
        this.#punctuation(',')
        this.#space()
      }
    }
    if (char === '[') {
      this.#punctuation('[')
      this.#space()
      if (this.text[this.#at] === ']') return this.#punctuation(']')
      for (;;) {
        // The items of a list under a secret key are secrets too.
        this.#value(secret, depth + 1)
        this.#space()
        if (this.text[this.#at] === ']') return this.#punctuation(']')
        this.#punctuation(',')
        this.#space()
      }
    }
    if (char === '"') {
      const token = this.#stringToken()
      this.#out.push(secret ? '""' : token)
      return
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.text.slice(this.#at, this.#at + 64),
    )
    if (!match) throw new Unreadable()
    this.#at += match[0].length
    this.#out.push(match[0])
  }
}

function scrubNested(text: string, depth: number): string {
  return Serialized.scrub(text, depth) ?? Json.scrub(text, depth) ?? text
}

/**
 * The bytes of a copied value with the string under every secret key blanked, in PHP's
 * serialization or JSON, at any depth; the bytes as they are when the value is neither.
 */
export function scrubNestedSecrets(value: Buffer): Buffer {
  const text = value.toString('latin1')
  const scrubbed = scrubNested(text, 0)
  return scrubbed === text ? value : Buffer.from(scrubbed, 'latin1')
}
