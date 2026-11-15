/**
 * The phone of the service as the public pages show it (the owner, 08.11.2026): the header of
 * the landing, the footer of the public pages, the lead section and the Organization markup of
 * the search engines.
 */
export const SITE_PHONE = { tel: '+79190483683', text: '+7 919 048-36-83' } as const

/** The mail of the support (the owner, 08.11.2026), as «Сведения об операторе» give it. */
export const SITE_EMAIL = 'luferovaea@yandex.ru'

/**
 * Who provides the service, in the column «Контакты» of the footer, as AnyNote names its seller.
 * The full name and the status are in «Сведения об операторе»; a test keeps the two the same.
 */
export const SITE_OPERATOR = {
  // Non-breaking spaces: the initials stay with the surname.
  name: 'Луферова\u00a0Е.\u00a0А.',
  status: 'самозанятая',
  inn: '673205843311',
} as const
