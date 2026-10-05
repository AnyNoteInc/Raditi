import { randomUUID } from 'node:crypto'

import {
  badRequest,
  DomainError,
  type PublishedContentFields,
  type PublishedContentPatch,
  type SecretStore,
} from '@repo/domain'
import { z } from 'zod'

import { findContacts } from './content-contacts.ts'

const marker = /\[\[raditi:(email|phone):([a-f0-9-]{36})\]\]/g
const entrySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['email', 'phone']),
  // The exact source bytes; an address written in entities is ten times its visible length.
  value: z.string().min(1).max(4096),
})
const mapSchema = z.array(entrySchema)
type Entry = z.infer<typeof entrySchema>
// The map is one KV value. The store takes 32 768 characters per value and 64 KiB per request,
// CAS envelope included; a write beyond either would be refused before it reaches Vault.
const MAP_CHARACTERS = 32_768
const MAP_REQUEST_BYTES = 64 * 1024 - 64
// A value this read adds joins the search for its repeats. Two passes settle a page; more
// are needed only when repeats run into each other and make new values.
const MASK_PASSES = 6
const unavailable = () =>
  new DomainError('CONTENT_PRIVACY_UNAVAILABLE', 'Content privacy map is unavailable', 503)
/** A size limit, not an outage: the task cannot learn more contacts and a retry cannot help. */
const full = () => new DomainError('CONTENT_PRIVACY_LIMIT', 'Content privacy map is full', 413)
/** The write would put a hidden contact where the next read shows it. Carries no content. */
const exposed = () =>
  new DomainError(
    'CONTENT_PRIVACY_CONTEXT',
    'A contact marker cannot be restored in this context',
    400,
  )
const fits = (entries: Entry[]) => {
  const encoded = JSON.stringify(entries)
  return (
    encoded.length <= MAP_CHARACTERS &&
    Buffer.byteLength(JSON.stringify({ entries: encoded })) <= MAP_REQUEST_BYTES &&
    mapSchema.safeParse(entries).success
  )
}

/**
 * Where the map of one task lives. Third parties' contacts are not access to a site: the
 * prefix stands apart from `kv/sites/<siteId>/`, which web writes and a deploy token reads.
 */
export function contentMaskPath(scope: { siteId: string; taskId: string }): string {
  if (!z.uuid().safeParse(scope.siteId).success || !z.uuid().safeParse(scope.taskId).success)
    throw badRequest('Invalid content privacy scope')
  return `kv/content-masks/${scope.siteId}/${scope.taskId}`
}

/** Raw contacts stay in Vault. The agent gets opaque task/site-scoped markers only. */
export class ContentPrivacy {
  constructor(private readonly secrets: Pick<SecretStore, 'kvRead' | 'kvWrite'>) {}

  /**
   * Hides what the text shows to be a contact and every repeat of a contact the task already
   * knows, those of this read included: one value is never a marker in one place and plain
   * text in another.
   */
  async mask(
    scope: { siteId: string; taskId: string },
    fields: PublishedContentFields,
  ): Promise<PublishedContentFields> {
    if (Object.values(fields).some((value) => value.includes('[[raditi:')))
      throw badRequest('Published content contains a reserved privacy marker')
    const path = contentMaskPath(scope)
    const texts = Object.entries(fields)
    let current = await this.#read(path)
    for (let attempt = 0; attempt < 4; attempt++) {
      const entries = [...current.entries]
      const known = new Map(entries.map((entry) => [`${entry.kind}:${entry.value}`, entry]))
      let masked: PublishedContentFields | undefined
      for (let pass = 0; !masked; pass++) {
        const searched = [...entries]
        const view = Object.fromEntries(
          texts.map(([key, text]) => {
            let result = ''
            let copied = 0
            for (const { kind, start, end } of findContacts(text, searched)) {
              const value = text.slice(start, end)
              let entry = known.get(`${kind}:${value}`)
              if (!entry) {
                entry = { id: randomUUID(), kind, value }
                entries.push(entry)
                known.set(`${kind}:${value}`, entry)
              }
              result += `${text.slice(copied, start)}[[raditi:${kind}:${entry.id}]]`
              copied = end
            }
            return [key, result + text.slice(copied)]
          }),
        ) as PublishedContentFields
        if (entries.length === searched.length) masked = view
        // Closed by default: a page that keeps yielding new values is not shown in part.
        else if (!fits(entries) || pass + 1 === MASK_PASSES) throw full()
      }
      if (entries.length === current.entries.length) return masked
      try {
        await this.secrets.kvWrite(
          path,
          { entries: JSON.stringify(entries) },
          { cas: current.version },
        )
        return masked
      } catch {
        // Never expose a token whose map was not durably acknowledged. Only another writer is
        // worth a new attempt: a map that did not move would refuse the same write again, and
        // after a lost acknowledgement it already holds these entries.
        const next = await this.#read(path)
        if (next.version === current.version) throw unavailable()
        current = next
      }
    }
    throw unavailable()
  }

  /**
   * Puts contacts back in place of their markers. The agent chooses the place, and whether a
   * number reads as a phone depends on what stands around it: every restored contact must be
   * one the next read hides again, by the same search and the same map, or nothing is written.
   */
  async rehydrate(
    scope: { siteId: string; taskId: string },
    patch: PublishedContentPatch,
  ): Promise<PublishedContentPatch> {
    const values = Object.values(patch)
    if (!values.some((value) => value.includes('[[raditi:'))) return { ...patch }
    const { entries } = await this.#read(contentMaskPath(scope))
    const byMarker = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]))
    return Object.fromEntries(
      Object.entries(patch).map(([field, value]) => {
        const placed: Array<{ start: number; end: number }> = []
        let restored = ''
        let copied = 0
        for (const token of value.matchAll(marker)) {
          const entry = byMarker.get(`${token[1]}:${token[2]}`)
          if (!entry) throw badRequest('Unknown content privacy marker')
          restored += value.slice(copied, token.index)
          placed.push({ start: restored.length, end: restored.length + entry.value.length })
          restored += entry.value
          copied = token.index + token[0].length
        }
        restored += value.slice(copied)
        if (restored.includes('[[raditi:')) throw badRequest('Invalid content privacy marker')
        const hidden = findContacts(restored, entries)
        let at = 0
        for (const { start, end } of placed) {
          while (at < hidden.length && hidden[at]!.end < end) at++
          if (at === hidden.length || hidden[at]!.start > start) throw exposed()
        }
        return [field, restored]
      }),
    ) as PublishedContentPatch
  }

  async #read(path: string) {
    try {
      const secret = await this.secrets.kvRead(path)
      if (!secret) return { version: 0, entries: [] as Entry[] }
      if (!secret.data.entries || secret.data.entries.length > MAP_CHARACTERS) throw unavailable()
      const parsed = mapSchema.safeParse(JSON.parse(secret.data.entries) as unknown)
      if (
        !parsed.success ||
        new Set(parsed.data.map((entry) => entry.id)).size !== parsed.data.length
      )
        throw unavailable()
      return { version: secret.version, entries: parsed.data }
    } catch {
      throw unavailable()
    }
  }
}
