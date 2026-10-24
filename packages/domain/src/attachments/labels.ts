import { pluralRu } from '../plural.ts'
import {
  attachmentLimits,
  attachmentTypeOf,
  attachmentTypes,
  type AttachmentRefusal,
} from './rules.ts'

/**
 * What the cabinet says about attached files (docs/plan/57-browser-tasks.md, Б26): sizes, types
 * and why a file was not taken. Russian, addressed with «вы», without the names of formats a
 * customer does not know. Safe in a browser.
 */

const KIB = 1024
const MIB = KIB * KIB

// «1,4»: one digit after a decimal comma, none when it is zero.
const oneDecimal = (value: number) => String(Math.round(value * 10) / 10).replace('.', ',')

/** «512 байт», «12 КБ», «1,4 МБ»: the size of a file for reading. */
export function attachmentSizeText(bytes: number): string {
  const whole = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0
  if (whole < KIB) return `${whole} ${pluralRu(whole, 'байт', 'байта', 'байт')}`
  const kib = Math.max(1, Math.round(whole / KIB))
  if (kib < KIB) return `${kib} КБ`
  return `${oneDecimal(whole / MIB)} МБ`
}

/** The type of a file as a customer reads it; «Файл» for a type not on the list. */
export const attachmentTypeLabel = (mime: string): string => attachmentTypeOf(mime)?.label ?? 'Файл'

const LIMIT = attachmentSizeText(attachmentLimits.fileBytes)

/** The line under the button that attaches files. */
export const attachmentHintText = `Изображения, документы, таблицы и презентации до ${LIMIT}, не больше ${attachmentLimits.perMessage} файлов к сообщению.`

/** The listed extensions, as a customer sees them in the file dialog: «JPG, JPEG, PNG, …». */
export const attachmentExtensionsText = attachmentTypes
  .flatMap((type) => type.extensions.map((extension) => extension.toUpperCase()))
  .join(', ')

/** Why a file was not attached, by the rule it broke. */
export const attachmentRefusalText: Readonly<Record<AttachmentRefusal, string>> = Object.freeze({
  type_not_allowed: `Такой файл прикрепить нельзя. Подойдут файлы ${attachmentExtensionsText}.`,
  content_mismatch:
    'Файл повреждён или не соответствует своему расширению. Проверьте, что он открывается, и прикрепите его снова.',
  text_encoding:
    'Текстовый файл сохранён в неподходящей кодировке. Сохраните его в кодировке UTF-8 и прикрепите снова.',
  empty: 'Файл пустой или без имени. Проверьте его и прикрепите снова.',
  too_large: `Файл больше ${LIMIT}. Уменьшите его или разделите на несколько файлов.`,
  too_many: `К одному сообщению можно прикрепить не больше ${attachmentLimits.perMessage} файлов.`,
})
