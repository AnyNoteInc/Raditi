import { describe, expect, it } from 'vitest'

import { SITE_PHONE } from '@/lib/contacts'

import { questions } from './landing'
import { landingSchema, schemaJson } from './landing-schema'
import { pricing } from './testing'

const origin = 'https://raditi.example'
const description = 'Радити меняет сайт по сообщению в чате.'

type Node = Record<string, unknown> & { '@type': string }

/** The graph of the page and its one node of a type. */
function graphOf(input: Partial<Parameters<typeof landingSchema>[0]> = {}) {
  const schema = landingSchema({ origin, description, plans: pricing.plans, questions, ...input })
  const nodes = schema['@graph'] as Node[]
  const node = (type: string): Node => {
    const found = nodes.filter((entry) => entry['@type'] === type)
    if (found.length !== 1) throw new Error(`${found.length} nodes of the type ${type}`)
    return found[0]!
  }
  return { schema, nodes, node }
}

describe('schema.org markup of the landing', () => {
  it('is one graph of the organization, the site, the service and the questions', () => {
    const { schema, nodes } = graphOf()

    expect(schema['@context']).toBe('https://schema.org')
    expect(nodes.map((node) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
      'FAQPage',
    ])
    // Every node has an address of its own under the origin of the service.
    const ids = nodes.map((node) => node['@id'])
    expect(ids).toEqual([
      `${origin}/#organization`,
      `${origin}/#website`,
      `${origin}/#service`,
      `${origin}/#faq`,
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('names the organization with the phone the page shows', () => {
    const { node } = graphOf()
    const organization = node('Organization')

    expect(organization).toMatchObject({
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
    })
    // The number in the international form, the one the links of the page call.
    expect(SITE_PHONE.tel).toMatch(/^\+7\d{10}$/)
  })

  it('names the site and the service in Russian, both of the one organization', () => {
    const { node } = graphOf()
    const organization = { '@id': `${origin}/#organization` }

    expect(node('WebSite')).toMatchObject({
      url: `${origin}/`,
      name: 'Радити',
      inLanguage: 'ru',
      publisher: organization,
    })
    expect(node('SoftwareApplication')).toMatchObject({
      name: 'Радити',
      url: `${origin}/`,
      description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: 'ru',
      provider: organization,
    })
  })

  it('offers every plan once, at the price of the page, in rubles', () => {
    const { node } = graphOf()

    expect(node('SoftwareApplication').offers).toEqual(
      pricing.plans.map((plan) => ({
        '@type': 'Offer',
        name: `Тариф «${plan.name}»`,
        price: plan.price,
        priceCurrency: 'RUB',
        url: `${origin}/#pricing`,
      })),
    )
    expect(pricing.plans).toHaveLength(3)
    // The price is the string of the database: no number, so no rounding of money.
    expect(node('SoftwareApplication').offers).toContainEqual(
      expect.objectContaining({ name: 'Тариф «Старт»', price: '1990.00' }),
    )
  })

  it('promises no offer when the plans did not load', () => {
    const { node, nodes } = graphOf({ plans: [] })

    expect(node('SoftwareApplication')).not.toHaveProperty('offers')
    // The rest of the graph does not depend on the plans.
    expect(nodes).toHaveLength(4)
    expect(JSON.stringify(nodes)).not.toContain('Offer')
  })

  it('mirrors the questions of the page, word for word and in their order', () => {
    const { node } = graphOf()

    expect(node('FAQPage').mainEntity).toEqual(
      questions.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    )
    expect(questions).toHaveLength(5)
    // Whatever list the page shows is the list of the markup.
    const one = [{ question: 'Вопрос?', answer: 'Ответ.' }]
    expect(graphOf({ questions: one }).node('FAQPage').mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'Вопрос?',
        acceptedAnswer: { '@type': 'Answer', text: 'Ответ.' },
      },
    ])
  })

  it('writes the graph as JSON that no text of the page can close the script element with', () => {
    const hostile = [{ question: 'Что такое </script><script>alert(1)</script>?', answer: '<b>' }]
    const json = schemaJson(graphOf({ questions: hostile }).schema)

    expect(json).not.toContain('<')
    expect(json).toContain('\\u003c/script>')
    // The escape is one of JSON: the reader gets the text back as it was.
    expect(JSON.parse(json)).toEqual(graphOf({ questions: hostile }).schema)
    expect(JSON.parse(schemaJson(graphOf().schema))).toEqual(graphOf().schema)
  })
})
