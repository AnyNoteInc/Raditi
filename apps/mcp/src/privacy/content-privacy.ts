import { badRequest, contactMarkerPattern, DomainError, type SecretStore } from '@repo/domain'
import { z } from 'zod'

import { findContacts } from './content-contacts.ts'

const entrySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['email', 'phone']),
  // The exact source bytes; an address written in entities is ten times its visible length.
  value: z.string().min(1).max(4096),
})
const mapSchema = z.array(entrySchema)
type Entry = z.infer<typeof entrySchema>
// The map is one KV value: the store took no more than 32 768 characters per value.
const MAP_CHARACTERS = 32_768
const unavailable = () =>
  new DomainError('CONTENT_PRIVACY_UNAVAILABLE', 'Content privacy map is unavailable', 503)
/** The write would put a hidden contact where the next read shows it. Carries no content. */
const exposed = () =>
  new DomainError(
    'CONTENT_PRIVACY_CONTEXT',
    'A contact marker cannot be restored in this context',
    400,
  )

/**
 * Where the map of one task lives. Third parties' contacts are not access to a site: the
 * prefix stands apart from `kv/sites/<siteId>/`, which web writes and a deploy token reads. The
 * `siteId` of the scope is `leaseScopeOf(task)`: a task without a site keeps its map under its own
 * id, in the same form of path, under the same policy.
 */
export function contentMaskPath(scope: { siteId: string; taskId: string }): string {
  if (!z.uuid().safeParse(scope.siteId).success || !z.uuid().safeParse(scope.taskId).success)
    throw badRequest('Invalid content privacy scope')
  return `kv/content-masks/${scope.siteId}/${scope.taskId}`
}

/**
 * The contacts behind the markers that pages showed the agent before 09.11.2026 (spec §20, ДС3):
 * pages are not masked any more, but a marker an earlier turn of the task read may still come
 * back in what the agent types. Raw contacts stay in Vault; nothing writes a map now.
 */
export class ContentPrivacy {
  constructor(private readonly secrets: Pick<SecretStore, 'kvRead'>) {}

  /**
   * Puts contacts back in place of their markers. The agent chooses the place, and whether a
   * number reads as a phone depends on what stands around it: every restored contact must be
   * one the next read hides again, by the same search and the same map, or nothing is written.
   */
  async rehydrate<
    Patch extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
  >(scope: { siteId: string; taskId: string }, patch: Patch): Promise<Patch> {
    const values = Object.values(patch)
    if (!values.some((value) => value.includes('[[raditi:'))) return { ...patch }
    const { entries } = await this.#read(contentMaskPath(scope))
    const byMarker = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]))
    return Object.fromEntries(
      Object.entries(patch).map(([field, value]) => {
        const placed: Array<{ start: number; end: number }> = []
        let restored = ''
        let copied = 0
        for (const token of value.matchAll(contactMarkerPattern())) {
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
    ) as Patch
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
