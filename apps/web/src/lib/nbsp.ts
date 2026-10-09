const NBSP = '\u00a0'

// Prepositions, conjunctions and the negation of one or two letters, and the prepositions of
// three: they belong to the next word.
const SHORT_WORDS = 'в|во|с|со|к|ко|о|об|у|и|а|но|на|до|за|по|не|ни|от|из|для|без|при|про|над|под'
// Particles belong to the word before them.
const PARTICLES = 'бы|же|ли'

// A word of its own: no letter, digit or hyphen next to it.
const NOT_IN_A_WORD_BEFORE = '(?<![\\p{L}\\p{N}-])'
const NOT_IN_A_WORD_AFTER = '(?![\\p{L}\\p{N}-])'

const beforeSeparator = / (?=[—·])/g
const afterNumber = /(?<=\d) (?=[\d₽%\p{L}])/gu
const afterShortWord = new RegExp(`${NOT_IN_A_WORD_BEFORE}(${SHORT_WORDS}) `, 'giu')
const beforeParticle = new RegExp(` (${PARTICLES})${NOT_IN_A_WORD_AFTER}`, 'giu')

/**
 * Puts non-breaking spaces into a readable Russian text, so that no line starts with a dash, ends
 * with a preposition or parts a number from its unit: «290 ₽», «250 мл», «10 правок».
 *
 * For visible prose only. The labels of buttons, links and form controls, `aria-label` and
 * metadata keep their plain spaces: tests and assistive technology look them up by exact name.
 */
export function nbsp(text: string): string {
  return text
    .replace(beforeSeparator, NBSP)
    .replace(afterNumber, NBSP)
    .replace(afterShortWord, `$1${NBSP}`)
    .replace(beforeParticle, `${NBSP}$1`)
}
