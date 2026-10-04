import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { legalDocuments } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { consentDocumentLinks, formatEditionDate, legalDocumentHref } from './legal'

const contentDir = fileURLToPath(new URL('../../content/legal/', import.meta.url))
const appDir = fileURLToPath(new URL('../app/', import.meta.url))
const sourceDir = fileURLToPath(new URL('../', import.meta.url))

const text = (slug: string) => readFileSync(`${contentDir}${slug}.md`, 'utf8')

/** Routes of the app that have a page: route groups such as `(protected)` are not in the path. */
function pageRoutes(directory = appDir, route = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return pageRoutes(
        `${directory}${entry.name}/`,
        entry.name.startsWith('(') ? route : `${route}/${entry.name}`,
      )
    return entry.name === 'page.tsx' ? [route || '/'] : []
  })
}

describe('legal documents', () => {
  it('every document of the registry has a text and every text is in the registry', () => {
    const files = readdirSync(contentDir)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => file.slice(0, -'.md'.length))
      .sort()
    const slugs = legalDocuments.map((document) => document.slug).sort()

    expect(files).toEqual(slugs)
  })

  it('consent checkboxes link to the documents of the registry', () => {
    const hrefs = new Set(legalDocuments.map((document) => legalDocumentHref(document.slug)))
    for (const href of Object.values(consentDocumentLinks())) expect(hrefs).toContain(href)
    expect(consentDocumentLinks().piiProcessing).toBe('/terms/consent')
  })

  it('carries in every text the edition date of the registry', () => {
    for (const document of legalDocuments)
      expect(text(document.slug), document.slug).toContain(
        `**Редакция от ${formatEditionDate(document.version)}**`,
      )
  })

  it('links only to pages of the site that exist', () => {
    const routes = new Set(pageRoutes())
    const documents = new Set(legalDocuments.map((document) => legalDocumentHref(document.slug)))
    expect(routes).toContain('/terms/[document]')
    for (const document of legalDocuments) {
      const links = [...text(document.slug).matchAll(/raditi\.ru(\/[\w\-./]*)?/g)]
      expect(links.length, document.slug).toBeGreaterThan(0)
      for (const [link, path = '/'] of links) {
        const route = path.replace(/(?<=.)\/$/, '')
        expect(routes.has(route) || documents.has(route), `${document.slug}: ${link}`).toBe(true)
      }
    }
  })

  it('names the real switch of the settings page as the way to withdraw the mailing consent', () => {
    const consent = text('marketing-consent')
    const [, label] = /переключатель «([^»]+)»/.exec(consent) ?? []
    expect(label).toBeDefined()
    expect(consent).toContain('(https://raditi.ru/settings)')
    expect(readFileSync(`${sourceDir}components/account/settings-panel.tsx`, 'utf8')).toContain(
      label,
    )
  })

  it('names the profile photo among the account data while the profile stores one (152-FZ)', () => {
    // The upload route is what makes the category real: both texts list the data and its term.
    expect(existsSync(`${appDir}api/profile/avatar/route.ts`)).toBe(true)
    const data = 'изображение профиля (фото), если Пользователь загрузил его добровольно'
    const term = 'изображение профиля — до его замены или удаления Пользователем'
    for (const slug of ['consent', 'privacy-policy']) {
      expect(text(slug), slug).toContain(data)
      expect(text(slug), slug).toContain(term)
    }
  })

  it('formats the edition date in Russian', () => {
    expect(formatEditionDate('2026-09-26')).toBe('26 сентября 2026 г.')
    expect(formatEditionDate('not a date')).toBe('not a date')
  })
})
