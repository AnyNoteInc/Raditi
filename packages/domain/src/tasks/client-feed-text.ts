/**
 * Text rules of the customer-facing feed (docs/research/2026-10-client-feed/feed-design.md):
 * what happens to the agent's words before they are stored and shown, and which of the
 * customer's own words are refused. Pure functions: no Vault, no network.
 */

/**
 * A masked contact as the agent sees it in site content (spec §11): `[[raditi:phone:<uuid>]]`
 * or `[[raditi:email:<uuid>]]`. One contract for the role that writes the markers and for the
 * feed that hides them. A source string, not a RegExp: a shared `g` pattern carries `lastIndex`.
 */
export const CONTACT_MARKER_SOURCE = String.raw`\[\[raditi:(email|phone):([a-f0-9-]{36})\]\]`
export const contactMarkerKinds = ['email', 'phone'] as const
export type ContactMarkerKind = (typeof contactMarkerKinds)[number]

/** A fresh global pattern: group 1 is the kind, group 2 the marker id. */
export const contactMarkerPattern = (): RegExp => new RegExp(CONTACT_MARKER_SOURCE, 'g')

/** What the customer reads in place of a marker. */
export const hiddenContactText: Readonly<Record<ContactMarkerKind | 'other', string>> =
  Object.freeze({
    phone: '(телефон скрыт)',
    email: '(почта скрыта)',
    other: '(скрыто)',
  })

// Anything else of the form `[[raditi:…]]` is hidden too. Three things are looked for: the
// opening of a marker, a closing pair of brackets and any other `[`. Brackets may be escaped with
// a backslash, as a model writing markdown does, and spaces may stand around the name.
const markerToken = /(\\?\[\\?\[\s*raditi\s*:)|(\\?\]\\?\])|\[/giu
// What is hidden of a marker that was never closed: up to the first space, bracket or backslash,
// with the closing brackets that follow.
const CUT_OFF_TAIL_SOURCE = String.raw`[^[\]\s\\]*(?:\\?\]){0,2}`
// A closed marker holds at most this many characters of its own, whole markers inside it aside.
const MARKER_BODY_LIMIT = 100

type OpenMarker = { start: number; bodyStart: number; nested: number; end: number | null }

/**
 * Replaces every marker with the words the customer reads. One pass over the brackets and one
 * over the markers found, so the time grows with the length of the text, and the words put in
 * are never read again.
 *
 * A closing pair closes the nearest marker still open, so a marker is hidden with the markers
 * inside it. It closes nothing when that marker has run past its hundred characters, and a `[`
 * that opens no marker leaves every open marker cut off: neither runs across the text that
 * follows. A cut-off marker is hidden up to the first space or bracket.
 */
function hideMarkers(text: string): string {
  const markers: OpenMarker[] = []
  const open: OpenMarker[] = []
  for (const token of text.matchAll(markerToken)) {
    if (token[1] !== undefined) {
      const marker = {
        start: token.index,
        bodyStart: token.index + token[0].length,
        nested: 0,
        end: null,
      }
      markers.push(marker)
      open.push(marker)
    } else if (token[2] === undefined) {
      open.length = 0
    } else {
      const marker = open.pop()
      if (marker === undefined) continue
      if (token.index - marker.bodyStart - marker.nested > MARKER_BODY_LIMIT) {
        // The markers opened before this one are longer still.
        open.length = 0
        continue
      }
      marker.end = token.index + token[0].length
      const outer = open.at(-1)
      if (outer !== undefined) outer.nested += marker.end - marker.start
    }
  }
  if (markers.length === 0) return text

  const contact = new RegExp(CONTACT_MARKER_SOURCE, 'y')
  const cutOffTail = new RegExp(CUT_OFF_TAIL_SOURCE, 'yu')
  const shown: string[] = []
  let from = 0
  for (const marker of markers) {
    // Inside a marker already hidden.
    if (marker.start < from) continue
    shown.push(text.slice(from, marker.start))
    if (marker.end === null) {
      cutOffTail.lastIndex = marker.bodyStart
      cutOffTail.exec(text)
      shown.push(hiddenContactText.other)
      from = cutOffTail.lastIndex
      continue
    }
    contact.lastIndex = marker.start
    const kind = contact.exec(text)?.[1] as ContactMarkerKind | undefined
    // Only the marker as the gateway writes it gets its own words.
    shown.push(
      kind !== undefined && contact.lastIndex === marker.end
        ? hiddenContactText[kind]
        : hiddenContactText.other,
    )
    from = marker.end
  }
  shown.push(text.slice(from))
  return shown.join('')
}

// Zero-width and direction-changing characters named by the design, and the other invisible
// format characters that would split a marker on its way to the patterns above: the soft
// hyphen, the Arabic letter mark, the word joiner with its neighbours and the byte order mark.
const invisible = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu
const lineBreak = /\r\n?/gu
const control = /[^\P{Cc}\n]/gu
// Half of a surrogate pair on its own: with the `u` flag a whole pair is one code point and
// does not match. JSON writes such a half as an escape that PostgreSQL jsonb refuses.
const loneSurrogate = /\p{Cs}/gu

/**
 * Agent text on its way to the customer: well-formed, NFC, no control, invisible or
 * direction-changing characters, masking markers replaced with Russian words. Line breaks stay.
 *
 * Idempotent, and the order is what makes it so. NFC runs after the removals: a removed
 * character may have stood between a letter and its combining mark. NFC itself never produces
 * a character the removals take, and the words put in place of a marker end in `)`, which
 * composes with nothing. Every opening of a marker is replaced, alone or with its marker, and
 * the words put in cannot be part of one, so the result holds no marker to find again.
 */
export function feedText(text: string): string {
  return hideMarkers(
    text
      // Removed, not replaced with U+FFFD: the customer would read that as a broken glyph.
      .replace(loneSurrogate, '')
      // Design reading: «перевод строки остаётся» covers CRLF and CR, and a tab becomes a
      // space rather than gluing two words together.
      .replace(lineBreak, '\n')
      .replaceAll('\t', ' ')
      .replace(control, '')
      .replace(invisible, '')
      .normalize('NFC'),
  )
}

/** True when feedText() would leave the text as it is: what a feed row may store. */
export const isFeedText = (text: string): boolean => feedText(text) === text

/** True when the text has something to read: not only spaces and invisible characters. */
export const hasVisibleText = (text: string): boolean => text.replace(invisible, '').trim() !== ''

/**
 * The longest request of a customer the feed stores, in characters after trimming: the value of
 * `feedLimits.requestText`. Kept here so that looksLikeSecret() can stop at it.
 */
export const FEED_REQUEST_TEXT_LIMIT = 4000

// How an address is told, on purpose narrowly: the word starts with a scheme and `://`
// (`https://…`, `FTP://…`) or with `www.`. Punctuation and symbols of any script may stand
// before it, as an opening bracket, a quote («, „, ") or a dash does. A bare domain, an e-mail
// address and a `mailto:` link are not addresses here: they go through the rules below like any
// other word.
const address = /^[\p{P}\p{S}]*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu
// Digits, Latin letters and special characters: every printable ASCII character but the space.
const passwordAlphabet = /^[!-~]{8,}$/u
const lowercase = /[a-z]/u
const uppercase = /[A-Z]/u
// What stands around a word in a sentence is not a character of it: quotes and brackets, `#` of
// a hashtag and `@` of a name before it, the punctuation of the sentence after it. A symbol
// such as `~` or `|` at an end stays: it belongs to the word.
const around = /^[«„“‘"'([{<#@]+|[.,!?:;…»“”’"')\]}>]+$/gu
// A character that makes a word with letters of both cases a password: a digit, or a special
// character that does not join the parts of a name (`-`, `.`, `_`, `/`, `=`, `:`).
const passwordMark = /[0-9!#$%&*+?^~|<>{}[\]();'"`,\\@]/u
// A name with a number at its end, «Bitrix24», «Summer2026» — and the commonest password shape,
// «Qwerty123»: only the message around tells one from the other.
const lettersThenDigits = /^[A-Za-z]+[0-9]+$/u
const nameJoiners = /[-._/=:]/gu
// An e-mail address, a domain or a file name: dot-separated parts ending in a part of letters
// (`Ivan.Petrov@example.ru`, `Example.ru/Page`, `Price2026.pdf`), never a password here.
const emailAddress = /^[^@]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u
const dottedName = /^(?:[A-Za-z0-9_-]+\.)+[A-Za-z]{2,}(?:[/?#].*)?$/u
// Words that say a secret is near: a password, a login, a key, a token, an access — or the
// name of an account a password follows («admin / Qwerty123»).
const credentialWord =
  /^(?:парол|логин|ключ|токен|секрет|доступ|password|passwd|pass$|pwd|login|token|secret|api[-_]?key|key$|admin$|админ$|root$|user$)/u

// Known formats of keys. The list is open and need not be complete: a customer may run their
// own installations that hand out keys with prefixes of their own, and the check does not try
// to guess them. The lower bounds keep an article number such as `sk-1234` out.
const notWord = String.raw`(?<![\p{L}\p{N}])`
const keyPrefix = new RegExp(
  notWord +
    '(?:' +
    [
      String.raw`sk-[A-Za-z0-9_-]{20,}`,
      String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
      String.raw`github_pat_[A-Za-z0-9_]{20,}`,
      String.raw`glpat-[A-Za-z0-9_-]{20,}`,
      String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
      String.raw`AKIA[0-9A-Z]{16}`,
    ].join('|') +
    ')',
  'u',
)
const privateKeyBlock = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u

// A three-part signed token: `eyJ…`, a dot, a second part, a dot, a third part, each of ten or
// more characters. Read by parts rather than by one pattern: a pattern would rescan a long run
// of token characters from every `eyJ` in it.
const tokenParts = /[A-Za-z0-9_-]+|[^A-Za-z0-9_-]/gu
const tokenHead = /(?:^|[_-])eyJ[A-Za-z0-9_-]{10}/u
const tokenHeadInside = /[_-]eyJ[A-Za-z0-9_-]{10}/u
const letterOrDigit = /[\p{L}\p{N}]/u
function hasSignedToken(word: string): boolean {
  const parts = word.match(tokenParts) ?? []
  for (const [i, head] of parts.entries()) {
    if (parts[i + 1] !== '.' || parts[i + 3] !== '.') continue
    // A part of ten or more characters is a run of token characters: any other part is one
    // character long.
    if ((parts[i + 2]?.length ?? 0) < 10 || (parts[i + 4]?.length ?? 0) < 10) continue
    const glued = i > 0 && letterOrDigit.test(parts[i - 1] ?? '')
    if ((glued ? tokenHeadInside : tokenHead).test(head)) return true
  }
  return false
}

/** The shape of a password a word has by itself: `strong`, `weak` (letters then digits), or none. */
function passwordShape(raw: string): 'strong' | 'weak' | null {
  const word = raw.replace(around, '')
  if (!passwordAlphabet.test(word) || !lowercase.test(word) || !uppercase.test(word)) return null
  if (!passwordMark.test(word)) return null
  if (emailAddress.test(word) || dottedName.test(word)) return null
  return lettersThenDigits.test(word.replace(nameJoiners, '')) ? 'weak' : 'strong'
}

/**
 * True when the customer's message looks like it carries a password or a key: such a message
 * is refused before it is stored (rule 2). A check by shape, not a guarantee.
 *
 * The message is split into words by whitespace; punctuation and symbols around a word are not
 * part of it. It refuses:
 * - a word that reads as a password: only digits, Latin letters and special characters
 *   (printable ASCII), eight or more of them, with both a lowercase and an uppercase letter and
 *   a digit or a special character — unless it is an e-mail address, a domain or a file name.
 *   Letters then digits («Qwerty123», «Bitrix24») is the shape of a name with a number as much
 *   as of a password: refused only when the message has a word of a secret — «пароль», «логин»,
 *   «ключ», «токен», «доступ», `password`, `token`, `admin` and the like;
 * - a word that holds a key of a known format, and a private key block.
 *
 * Names of products and ordinary words are let through: letters alone are never a password
 * («WordPress», «JavaScript», «Welcome!»), nor are `-`, `.`, `_`, `/`, `=` and `:` that join the
 * parts of a name («Check-In», `utm_source=Yandex`) — owner's answer of 26.10.2026 «исправь как
 * нужно» after the refusals of the literal rule of 11.10.2026. Addresses are let through on
 * purpose, whatever they hold — a key in the query, a name and a password before the host: the
 * customer takes the responsibility for what an address carries. So are passwords the rule does
 * not describe: in one case («qwerty123»), shorter than eight characters, of letters alone, or
 * with a letter that is not Latin («пароль: солнышко»).
 *
 * A text longer than FEED_REQUEST_TEXT_LIMIT after trimming is not read at all and the answer
 * is true. It cannot be stored anyway, reading it costs time that grows faster than its length
 * (NFC over a long run of combining marks), and «refuse» is the answer that lets no secret
 * through. A caller that wants to tell the customer the right reason checks the length first.
 */
export function looksLikeSecret(text: string): boolean {
  if (text.trim().length > FEED_REQUEST_TEXT_LIMIT) return true
  const plain = text.replace(invisible, '').normalize('NFC')
  const words = plain.split(/\s+/u).filter((word) => !address.test(word))
  // A word of a secret near a value, as the customer writes it: «Пароль:», `password=`.
  const nearSecret = plain
    .split(/\s+/u)
    .some((word) => credentialWord.test(word.replace(around, '').toLowerCase()))
  return (
    // The block is read across words, with the addresses taken out.
    privateKeyBlock.test(words.join(' ')) ||
    words.some((word) => {
      // A value glued to its label, `пароль=Qwerty123`, is read on its own as well.
      const shapes = [word, ...word.split(/[=:]/u)].map(passwordShape)
      return (
        shapes.includes('strong') ||
        (shapes.includes('weak') && nearSecret) ||
        keyPrefix.test(word) ||
        hasSignedToken(word)
      )
    })
  )
}
