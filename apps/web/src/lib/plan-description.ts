const descriptions: Readonly<Record<string, string>> = {
  start: 'Для своего дела',
  business: 'Когда задач становится больше',
  agency: 'Для сайтов ваших клиентов',
}

/**
 * Whom a tariff is for, in one line, by its slug. The landing and the «Тарифы» page of the
 * settings say the same; a tariff without a line of its own gets a neutral one.
 */
export function planDescription(slug: string): string {
  return (
    (Object.hasOwn(descriptions, slug) ? descriptions[slug] : undefined) ??
    'Для регулярных задач на сайте'
  )
}
