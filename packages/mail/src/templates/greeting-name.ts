/** Longest name a letter greets by; a longer one is left out. */
export const MAX_GREETING_NAME_LENGTH = 100

// Letters, marks, digits, spaces and the punctuation of personal and company names. No '@',
// '/', ':' or angle brackets: nothing that makes an address or a link.
const ALLOWED = /^[\p{L}\p{M}\p{N} .,'’‘"«»()&№–—-]+$/u
// "evil.ru", "t.me", "сайт.рф": a dot followed by a top-level-domain-like word.
const DOMAIN_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u
// Control, invisible formatting (bidi overrides, zero-width) and line or paragraph breaks.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
// Enough for "ООО Ромашка 2000", too few for a phone number.
const MAX_DIGITS = 4

/**
 * The name as a letter may show it, or null to greet without it. The name is whatever was
 * typed at sign-up, and letters come from noreply@raditi.ru, so a name that carries a link,
 * an address, a phone number or several lines of text is never shown.
 */
export function greetingName(name: string | null | undefined): string | null {
  if (!name) return null
  // NFKC folds look-alikes such as fullwidth "＠" and "．" into the characters checked below.
  const normalized = name.normalize('NFKC')
  if (UNSAFE_CHARS.test(normalized)) return null
  const collapsed = normalized.replace(/\p{Zs}+/gu, ' ').trim()
  if (collapsed === '' || [...collapsed].length > MAX_GREETING_NAME_LENGTH) return null
  if (!ALLOWED.test(collapsed) || DOMAIN_LIKE.test(collapsed)) return null
  if ((collapsed.match(/\p{N}/gu)?.length ?? 0) > MAX_DIGITS) return null
  return collapsed
}
