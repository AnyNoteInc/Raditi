/**
 * Finds e-mail addresses and phone numbers in published text or HTML.
 *
 * Detection reads a folded copy of the text: an entity, a percent escape, a Unicode space or dash
 * becomes the one ASCII character it means. Contacts come back in offsets of the source, so the
 * caller stores and restores the exact bytes. Every scan is linear in the length of the text.
 *
 * This is not a classifier of personal data. Obfuscated contacts («ivan [at] mail.ru»), a number
 * split by tags and an international number written with 00 instead of a plus are not found.
 *
 * What a number is depends on the words and digits around it, so a contact found once is then
 * searched for by its own characters: see `repeats`.
 */
export interface Contact {
  kind: 'email' | 'phone'
  start: number
  end: number
}
/** A contact that some read has found: its kind and its exact source characters. */
export type KnownContact = Pick<Contact, 'kind'> & { value: string }

const namedEntities = new Map<string, number>([
  ...['nbsp', 'ensp', 'emsp', 'thinsp', 'numsp', 'puncsp', 'hairsp'].map(
    (name) => [name, 0x20] as const,
  ),
  ...['ndash', 'mdash', 'minus', 'hyphen', 'dash', 'horbar'].map((name) => [name, 0x2d] as const),
  ['lpar', 0x28],
  ['rpar', 0x29],
  ['plus', 0x2b],
  ['period', 0x2e],
  ['commat', 0x40],
  ['shy', 0x2d],
])
const entity = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-z]{3,6}));/y
const escaped = /%([0-9a-fA-F]{2})/y

/**
 * Spaces and dashes of any kind read as ' ' and '-', a tab and the invisible ones too (a zero-width
 * space keeps a number from becoming a link on phones); everything else stays itself.
 */
function fold(code: number): number {
  if (code < 0xa0) return code === 0x09 ? 0x20 : code
  if (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200b) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x2060 ||
    code === 0x3000 ||
    code === 0xfeff
  )
    return 0x20
  return (code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0xad ? 0x2d : code
}

function reference([, decimal, hex, name]: RegExpExecArray): number | undefined {
  if (name !== undefined) return namedEntities.get(name)
  const code = decimal === undefined ? Number.parseInt(hex!, 16) : Number(decimal)
  // A control or astral reference is no part of a contact: one opaque character.
  return code >= 0x20 && code <= 0xffff && (code < 0xd800 || code > 0xdfff) ? fold(code) : 0xfffd
}

/** One character per source atom; `offsets[i]` is where the atom of `plain[i]` starts. */
function normalize(text: string): { plain: string; offsets: Uint32Array } {
  const offsets = new Uint32Array(text.length + 1)
  const parts: string[] = []
  let length = 0
  let copied = 0
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index)
    let meaning = fold(code)
    let next = index + 1
    if (code === 0x26) {
      entity.lastIndex = index
      const match = entity.exec(text)
      const decoded = match ? reference(match) : undefined
      if (decoded !== undefined) [meaning, next] = [decoded, entity.lastIndex]
    } else if (code === 0x25) {
      escaped.lastIndex = index
      const byte = Number.parseInt(escaped.exec(text)?.[1] ?? '', 16)
      if (byte >= 0x20 && byte < 0x7f) [meaning, next] = [byte, index + 3]
    }
    if (meaning !== code || next !== index + 1) {
      parts.push(text.slice(copied, index), String.fromCharCode(meaning))
      copied = next
    }
    offsets[length++] = index
    index = next
  }
  parts.push(text.slice(copied))
  offsets[length] = text.length
  return { plain: parts.join(''), offsets }
}

const digit = (plain: string, index: number) => {
  const code = plain.charCodeAt(index)
  return code >= 0x30 && code <= 0x39
}
const word = /[\p{L}\p{N}]/u
/** A letter or digit of any script. Out of range and a lone surrogate are neither. */
function alnum(plain: string, index: number): boolean {
  const code = plain.charCodeAt(index)
  if (code >= 0x80) return word.test(plain[index]!)
  return digit(plain, index) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

// Names such as logo@2x.png are files: none of these is a top-level domain.
const fileSuffixes = new Set('png jpg jpeg gif webp svg avif bmp ico tif tiff'.split(' '))
const punycode = /^xn--[a-z0-9-]{1,59}$/i
const letters = /^\p{L}{2,63}/u

/** Length of the top-level domain a label starts with: all of «ru», two of «ru8», none of «21». */
function topLevel(label: string): number {
  if (punycode.test(label)) return label.length
  const name = letters.exec(label)?.[0] ?? ''
  return fileSuffixes.has(name.toLowerCase()) ? 0 : name.length
}

/** End of the longest `label(.label)+` that ends with a top-level domain, or -1. */
function domainEnd(plain: string, from: number): number {
  const limit = Math.min(plain.length, from + 255)
  let found = -1
  for (let index = from, labels = 1; ; labels++) {
    const start = index
    while (index < limit && (alnum(plain, index) || plain[index] === '-')) index++
    let end = index
    while (end > start && plain[end - 1] === '-') end--
    const top = labels > 1 ? topLevel(plain.slice(start, end)) : 0
    if (top) found = start + top
    if (end === start || end !== index || index >= limit || plain[index] !== '.') return found
    index++
  }
}

/**
 * Starts from each at sign instead of trying every position: the local part and the domain are
 * bounded and never cross another at sign, so the whole text is read a constant number of times.
 */
function emails(plain: string): Contact[] {
  const found: Contact[] = []
  let floor = 0
  for (let at = plain.indexOf('@'); at !== -1; at = plain.indexOf('@', at + 1)) {
    let start = at
    while (
      start > floor &&
      at - start < 64 &&
      (alnum(plain, start - 1) || '._+-'.includes(plain[start - 1]!))
    )
      start--
    while (plain[start] === '.') start++
    const end = start < at ? domainEnd(plain, at + 1) : -1
    if (end === -1) continue
    found.push({ kind: 'email', start, end })
    floor = end
  }
  return found
}

type Link = '' | ' ' | '-' | '.'
/** A run of digits and the separator that ties it to the run before. */
interface Group {
  start: number
  end: number
  link: Link
}
const MAX_DIGITS = 15 // E.164
const MAX_GROUPS = 8
const separator = /\)? {0,2}[-.]? {0,2}\(?/y
const size = (group: Group) => group.end - group.start

/** A dot ties groups only alone: «8.800.555» is a number, «67. 15» and «2026 - 15.10» are not. */
function linkOf(between: string): Link {
  if (between.includes('.')) return between === '.' ? '.' : ''
  return between.includes('-') ? '-' : ' '
}

/** Digit groups tied by phone separators, from the digit at `from`. A longer run is cut short. */
function chain(plain: string, from: number): Group[] {
  const groups: Group[] = []
  let start = from
  let link: Link = ''
  for (;;) {
    let end = start
    while (end - start <= MAX_DIGITS && digit(plain, end)) end++
    groups.push({ start, end, link })
    if (groups.length === MAX_GROUPS || end - start > MAX_DIGITS) return groups
    separator.lastIndex = end
    separator.exec(plain)
    const next = separator.lastIndex
    link = next > end && digit(plain, next) ? linkOf(plain.slice(end, next)) : ''
    if (!link) return groups
    start = next
  }
}

const linked = /\d(\)? {0,2}[-.]? {0,2}\(?)$/
/** The separator that ties the group at `index` to a digit before it, or ''. */
function linkBefore(plain: string, index: number): Link {
  const between = linked.exec(plain.slice(Math.max(0, index - 8), index))?.[1]
  return between ? linkOf(between) : ''
}

/**
 * How many leading groups hold exactly `total` digits, or 0. Dots tie all of the groups, as in
 * «8.800.555.35.35», or the last three, as in «8 (495) 123.45.67»: «80488 - 10.00-19» is not one.
 */
function take(groups: Group[], total: number): number {
  let digits = 0
  for (let count = 1; count <= groups.length; count++) {
    digits += size(groups[count - 1]!)
    if (digits < total) continue
    const dots = groups.slice(1, count).map((group) => group.link === '.')
    const tail = dots.slice(0, -2).every((dot) => dot === dots[0]) && dots.at(-2) && dots.at(-1)
    return digits === total && (!dots.includes(true) || tail) ? count : 0
  }
  return 0
}

/** The group opens a date, a time or a decimal: 01.10, 10:00, 1.5. A comma may part two numbers. */
const fraction = (plain: string, group: Group) =>
  (plain[group.end] === '.' || plain[group.end] === ':') && digit(plain, group.end + 1)

/** A bare hyphen or dot glues more digits to the first `count` groups: no number ends there. */
function goesOn(plain: string, groups: Group[], count: number): boolean {
  const next = groups[count]
  return next !== undefined && '-.'.includes(plain.slice(groups[count - 1]!.end, next.start))
}

const phoneWords =
  /(?:(?<![\p{L}\p{N}])(?:т|т\/ф|тлф|тел|телефон\p{L}{0,3}|моб|мобильн\p{L}{0,4}|факс\p{L}{0,2}|(?:по)?звон\p{L}{0,4}|tel|telephone|phone|fax|mob|mobile|whatsapp|viber|wa\.me|callto|sms)|[?&]number)$/u
const requisiteWords = /(?<![\p{L}\p{N}])(?:инн|кпп|огрн|огрнип|окпо|октмо|окато|бик)$/u

/** Do these words stand right before `index`, past punctuation and up to three inline tags? */
function follows(plain: string, index: number, words: RegExp): boolean {
  let end = index
  for (let skipped = 0, tags = 0; end > 0 && !alnum(plain, end - 1);) {
    if (plain[end - 1] !== '>') {
      if (++skipped > 8) return false
      end--
      continue
    }
    const floor = Math.max(0, end - 64)
    let open = end - 2
    while (open >= floor && plain[open] !== '<' && plain[open] !== '>') open--
    if (open < floor || plain[open] !== '<' || ++tags > 3) return false
    end = open
  }
  // No such word ends with a digit: a number after a number costs nothing.
  if (end === 0 || digit(plain, end - 1)) return false
  return words.test(plain.slice(Math.max(0, end - 16), end).toLowerCase())
}

const nationalCodes = '034789' // +7 and its neighbours: no area or mobile code starts otherwise
// The trunk prefix written together with the code: «8800 555-35-35», «84852 12-34-56».
const gluedShapes = ['4-3-2-2', '4-3-4', '4-4-3', '4-3-1-3', '5-2-2-2', '5-3-3', '6-1-2-2']

/** 8 or 7 and ten national digits: 8 (999) 123-45-67, 8 800 555-3-555, 89991234567. */
function trunk(plain: string, groups: Group[]): number {
  const first = groups[0]!
  if (plain[first.start] !== '7' && plain[first.start] !== '8') return 0
  const head = size(first)
  if (head === 1) {
    // A code of three digits or more: not a list of sizes, not a sum grouped by thousands.
    const count = size(groups[1] ?? first) >= 3 ? take(groups, 11) : 0
    return count && size(groups[count - 1]!) >= 2 ? count : 0
  }
  if (!nationalCodes.includes(plain[first.start + 1]!)) return 0
  // Bare digits after «ОКТМО» or «ИНН» are company details.
  if (head === 11) return follows(plain, first.start, requisiteWords) ? 0 : 1
  const count = take(groups, 11)
  const taken = groups.slice(0, count)
  return gluedShapes.includes(taken.map(size).join('-')) &&
    !/[().]/.test(plain.slice(first.end, taken[count - 1]!.start)) &&
    !goesOn(plain, groups, count)
    ? count
    : 0
}

/** Ten national digits, code first: (495) 123-45-67, 495 123-45-67, 212-555-1234. */
function area(plain: string, groups: Group[]): number {
  const first = groups[0]!
  const count = size(first) >= 3 && size(first) <= 5 ? take(groups, 10) : 0
  if (!count) return 0
  const coded = nationalCodes.includes(plain[first.start]!)
  if (plain[first.start - 1] === '(' && plain[first.end] === ')')
    return size(first) === 3 || coded ? count : 0
  // Without parentheses only the rhythm of a phone counts: never a date, a range or a price.
  const taken = groups.slice(0, count)
  const shape = taken.map(size).join('-')
  const links = taken.slice(1).map((group) => group.link)
  if (fraction(plain, taken[count - 1]!) || goesOn(plain, groups, count)) return 0
  // 212-555-1234 and 212.555.1234 are written so in any country.
  if (shape === '3-3-4' && links[0] !== ' ' && links[0] === links[1]) return count
  if (!coded) return 0
  if (['3-3-2-2', '4-2-2-2', '5-1-2-2'].includes(shape)) return count
  if (shape !== '3-3-4' && shape !== '4-3-3') return 0
  if (links.includes('-')) return count
  // With spaces alone «950 000 2021» is a price and a year, «3500 200 150» are sizes.
  return shape === '3-3-4' && plain.slice(taken[1]!.start, taken[1]!.end) !== '000' ? count : 0
}

/** A local number, 123-45-67 or 123 45 67, unless it is cut out of a decimal or dotted figure. */
function local(plain: string, groups: Group[]): number {
  const [first, second, third] = groups
  if (!third || size(first!) !== 3 || size(second!) !== 2 || size(third) !== 2) return 0
  if (/[().]/.test(plain.slice(first!.end, third.start)) || fraction(plain, third)) return 0
  return linkBefore(plain, first!.start) === '.' ? 0 : 3
}

const money = /^ ?(?:[₽$€]|руб(?:\.|л(?:ь|я|ей))?(?![\p{L}\p{N}]))/u

/** The reading ends in thousands that run on to a currency: «4500 - 150 000 руб.». */
function priced(plain: string, groups: Group[], count: number): boolean {
  let last = count - 1
  if (size(groups[last]!) !== 3 || groups[last]!.link !== ' ') return false
  while (groups[last + 1] && size(groups[last + 1]!) === 3 && groups[last + 1]!.link === ' ') last++
  const end = groups[last]!.end
  return money.test(plain.slice(end, end + 9).toLowerCase())
}

/** A number written without a plus sign, by its shape alone. */
function national(plain: string, groups: Group[]): number {
  const count = area(plain, groups) || trunk(plain, groups) || local(plain, groups)
  return count && !priced(plain, groups, count) ? count : 0
}

/**
 * A number of unknown length: the groups that fit in 15 digits. Once `min` digits are there it
 * stops before a date, a time or a decimal and before the next number, so that this one never
 * swallows the head of its neighbour. Dots count as separators only where the caller accepts
 * them: «+49.30.123456», but never «…, 01.10.2026».
 * A sum grouped by thousands before a currency is no number: «+10 000 000 ₽», «12 999 руб.».
 */
function greedy(plain: string, groups: Group[], min: number, dots: boolean): number {
  let digits = 0
  let count = 0
  for (const group of groups) {
    const dot = group.link === '.'
    if (dot && !dots) break
    if (digits + size(group) > MAX_DIGITS) break
    if (digits >= min) {
      const rest = chain(plain, group.start)
      const next = national(plain, rest)
      if (next && !goesOn(plain, rest, next)) break
    }
    const ownDot = dots && digits < min && plain[group.end] === '.'
    if (!dot && !ownDot && fraction(plain, group)) break
    digits += size(group)
    count++
  }
  if (digits < min) return 0
  const taken = groups.slice(0, count)
  const end = taken[count - 1]!.end
  const sum = taken.every((group, at) =>
    at === 0 ? count === 1 || size(group) <= 3 : size(group) === 3 && group.link === ' ',
  )
  return sum && money.test(plain.slice(end, end + 9).toLowerCase()) ? 0 : count
}

// Digits of a whole number where the country fixes them: +7, +1 and the nearest neighbours.
const fixedLengths = new Map<string, number>([
  ['7', 11],
  ['1', 11],
  ...['375', '380', '992', '994', '995', '996', '998'].map((code) => [code, 12] as const),
  ...['370', '371', '373', '374', '993'].map((code) => [code, 11] as const),
])

/** After a plus sign: the length the country code fixes, otherwise 8 to 15 digits. */
function international(plain: string, groups: Group[]): number {
  const lead = groups
    .slice(0, 3)
    .map((group) => plain.slice(group.start, group.end))
    .join('')
  const total = fixedLengths.get(lead[0]!) ?? fixedLengths.get(lead.slice(0, 3))
  return (total && take(groups, total)) || greedy(plain, groups, 8, true)
}

/**
 * End of a number, stretched while another shape that starts inside it ends past it. In
 * «№ 87765 386 664 69 26» an order number and a phone share digits: both readings go under one
 * marker, so that the tail of the phone is never left in plain view.
 */
function reach(plain: string, groups: Group[], count: number): number {
  let end = groups[count - 1]!.end
  for (let at = 1, rest = groups; at < rest.length && rest[at]!.start < end; at++) {
    const inner = chain(plain, rest[at]!.start)
    const taken = national(plain, inner)
    if (taken && inner[taken - 1]!.end > end) {
      end = inner[taken - 1]!.end
      ;[rest, at] = [inner, 0]
    }
  }
  return end
}

const listed = /^ ?(?:[,;/|]|и|или|and|or) ?$/u

/**
 * Where the text says «phone», or goes on with such a list, five digits are a number:
 * «тел. 2-12-34, 2-15-67», «tel:1234567».
 */
function announced(plain: string, groups: Group[], start: number, previous: number): number {
  const named = follows(plain, start, phoneWords)
  const inList =
    previous >= 0 &&
    start - previous <= 6 &&
    listed.test(plain.slice(previous, start).toLowerCase())
  return named || inList ? greedy(plain, groups, 5, named) : 0
}

/**
 * Tries the known shapes of a phone at every digit group, left to right, so that neighbouring
 * numbers are found one by one and nothing that merely contains digits is taken for a phone.
 */
function phones(plain: string): Contact[] {
  const found: Contact[] = []
  let previous = -1
  for (let index = 0; index < plain.length; index++) {
    if (!digit(plain, index)) continue
    const groups = chain(plain, index)
    const plus = plain[index - 1] === '+'
    let start = plus ? index - 1 : index
    const shaped = plus ? international(plain, groups) : national(plain, groups)
    const count = shaped || announced(plain, groups, start, previous)
    if (!count) {
      index = groups[0]!.end - 1
      while (digit(plain, index + 1)) index++
      continue
    }
    const end = reach(plain, groups, count)
    const taken = plain.slice(index, end)
    // Keep «(495) …» and «(8 495) …» whole.
    if (!plus && plain[index - 1] === '(' && taken.split(')').length > taken.split('(').length)
      start--
    found.push({ kind: 'phone', start, end })
    // Only an announced number goes on as a list: a full one does not turn the postcode or the
    // years after it into phones.
    previous = shaped ? -1 : end
    index = end - 1
  }
  return found
}

// The shortest number the text can announce: «тел. 2-12-34».
const MIN_KNOWN_DIGITS = 5
const phoneSeparators = /[ \-.()]/g

/**
 * Where the text repeats a known contact, in source offsets. Its exact characters are taken
 * wherever they stand, glued to other digits or letters too: where a marker goes back is the
 * agent's choice. A phone is also taken in another spelling, bare digits, other separators or
 * another trunk prefix, where it stands as a whole number. Each contact costs a few passes
 * over the text.
 */
function repeats(
  text: string,
  plain: string,
  offsets: Uint32Array,
  known: readonly KnownContact[],
): Contact[] {
  const found: Contact[] = []
  const spellings = new Set<string>()
  for (const { kind, value } of known) {
    if (!value) continue
    let last: Contact | undefined
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      // Copies that run into each other are one stretch: no tail of the last one is left out.
      if (last && at < last.end) last.end = at + value.length
      else found.push((last = { kind, start: at, end: at + value.length }))
    }
    if (kind !== 'phone') continue
    const digits = normalize(value).plain.replace(/\D/g, '')
    if (digits.length < MIN_KNOWN_DIGITS) continue
    spellings.add(digits)
    // One Russian number: with +7, with 8 and with the code alone.
    const national =
      digits.length === 10 ? digits : /^[78]\d{10}$/.test(digits) ? digits.slice(1) : ''
    if (national) for (const prefix of ['', '7', '8']) spellings.add(prefix + national)
  }
  if (spellings.size === 0) return found
  const compact = plain.replace(phoneSeparators, '')
  const kept = new Uint32Array(compact.length)
  for (let index = 0, length = 0; index < plain.length; index++) {
    const code = plain.charCodeAt(index)
    if (code !== 0x20 && code !== 0x2d && code !== 0x2e && code !== 0x28 && code !== 0x29)
      kept[length++] = index
  }
  for (const digits of spellings)
    for (let at = compact.indexOf(digits); at !== -1; at = compact.indexOf(digits, at + 1)) {
      const start = kept[at]!
      const end = kept[at + digits.length - 1]! + 1
      // Inside a longer run of digits these are the digits of something else.
      if (digit(plain, start - 1) || digit(plain, end)) continue
      found.push({ kind: 'phone', start: offsets[start]!, end: offsets[end]! })
    }
  return found
}

/**
 * Contacts in source offsets, in order and without overlaps: those the text shows by its shape
 * and every repeat of a `known` one. What overlaps goes under one contact.
 */
export function findContacts(text: string, known: readonly KnownContact[] = []): Contact[] {
  const { plain, offsets } = normalize(text)
  const shaped = [...emails(plain), ...phones(plain)].map(({ kind, start, end }) => ({
    kind,
    start: offsets[start]!,
    end: offsets[end]!,
  }))
  const merged: Contact[] = []
  for (const contact of [...shaped, ...repeats(text, plain, offsets, known)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const last = merged.at(-1)
    if (!last || contact.start >= last.end) merged.push(contact)
    else {
      // A number inside or glued to an address is one contact: one marker for both.
      last.end = Math.max(last.end, contact.end)
      if (contact.kind === 'email') last.kind = 'email'
    }
  }
  return merged
}
