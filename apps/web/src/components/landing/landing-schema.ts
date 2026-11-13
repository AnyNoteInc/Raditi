import { SITE_PHONE } from '@/lib/contacts'

import type { LandingPlan } from './pricing-calculator'

/**
 * The page in the words of schema.org, for the search engines and the answer engines: who the
 * service is and how to reach it, what it is and what it costs, and the questions with their
 * answers. Every value is what the page itself shows — the plans of the database, the questions
 * of the FAQ — so the markup cannot promise what the page does not.
 */
export function landingSchema({
  origin,
  description,
  plans,
  questions,
}: {
  origin: string
  description: string
  plans: readonly LandingPlan[]
  questions: readonly { question: string; answer: string }[]
}) {
  const organization = { '@id': `${origin}/#organization` }
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        ...organization,
        name: 'Радити',
        url: `${origin}/`,
        logo: `${origin}/brand-icon.png`,
        telephone: SITE_PHONE.tel,
        contactPoint: {
          '@type': 'ContactPoint',
          telephone: SITE_PHONE.tel,
          contactType: 'sales',
          areaServed: 'RU',
          availableLanguage: 'ru',
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: `${origin}/`,
        name: 'Радити',
        inLanguage: 'ru',
        publisher: organization,
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#service`,
        name: 'Радити',
        url: `${origin}/`,
        description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: 'ru',
        provider: organization,
        ...(plans.length > 0 && {
          offers: plans.map((plan) => ({
            '@type': 'Offer',
            name: `Тариф «${plan.name}»`,
            price: plan.price,
            priceCurrency: 'RUB',
            url: `${origin}/#pricing`,
          })),
        }),
      },
      {
        '@type': 'FAQPage',
        '@id': `${origin}/#faq`,
        mainEntity: questions.map(({ question, answer }) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer },
        })),
      },
    ],
  }
}

/** JSON for a script element: `<` is escaped, so no text of the page can close the element. */
export const schemaJson = (schema: unknown): string =>
  JSON.stringify(schema).replaceAll('<', '\\u003c')
