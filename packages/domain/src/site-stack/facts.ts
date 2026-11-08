/**
 * What the platform knows of a site: the record `sites.stack_facts` (docs/plan/62-site-stacks.md,
 * Т13, Т14, §2.3). Written in parts (`mergeSiteStackFacts` in @repo/db: `stack_facts || $1`) by
 * the wizard, the import, a fresh copy and the trial boot, read by everyone through
 * `siteStackFactsOf`. A value from the hosting is untrusted: one that fails its schema is read as
 * unknown, and an unknown value only narrows what the platform does.
 */
import { z } from 'zod'

import { siteLimits } from './stacks.ts'

/**
 * A version of the CMS as the hosting gives it: up to four numbers and a short suffix, which may
 * follow a dot — so the fifth number of ocStore 2.3 (`2.3.0.2.4`) passes as one (`3.0.4.1b`,
 * `2.8.9-pl`, `4.0.0.rc1`). Never a line of text: an instruction of a turn names a generation,
 * not this string.
 */
export const siteVersionSchema = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+){0,3}([-.]?[a-z0-9]{1,12})?$/i)

/** A value from the hosting: one that does not pass the schema is null (an unknown version). */
export function parseSiteVersion(raw: string): string | null {
  const parsed = siteVersionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const generationId = z.string().regex(/^[a-z0-9]{1,16}$/)
const phpVersion = z
  .string()
  .max(8)
  .regex(/^\d+\.\d+$/)

/**
 * A string from the hosting kept in the record: no control character and no lone surrogate, which
 * PostgreSQL refuses to read as jsonb (`\u0000` gives 22P05), so a write fails before the query.
 */
const hostingText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cs}]*$/u)

/**
 * The bytes `extras` take in the text of a jsonb, which adds a space after each `:` and `,`. With
 * this bound every record the schema takes fits `sites_stack_facts_check` (4096 bytes): the other
 * keys together take well under 1 KiB.
 */
export const siteStackExtrasMaxBytes = 3072
const utf8 = new TextEncoder()
function extrasBytes(extras: Readonly<Record<string, string>>): number {
  return utf8.encode(JSON.stringify(extras)).length + 2 * Object.keys(extras).length
}
const extrasSchema = z
  .record(hostingText(32), hostingText(256))
  .refine((extras) => extrasBytes(extras) <= siteStackExtrasMaxBytes)

/**
 * The folder of the site's panel from its root. Comes from the hosting and becomes a start page of
 * the browser (`new URL(path, origin)`): `//host/` would leave the site, `..` its root (Р3).
 */
const adminPathSchema = z
  .string()
  .regex(/^\/(?!\/)[\w./-]{1,64}\/$/)
  .refine((path) => !path.split('/').includes('..'))

/**
 * `sites.stack_facts`: JSONB NOT NULL DEFAULT '{}', CHECK of an object of at most 4 KiB. Every
 * string is bounded, so the largest record the schema takes passes the check.
 */
export const siteStackFactsSchema = z.strictObject({
  v: z.literal(1),
  /** 5.4.10; `sites.installed_version` is the tag of a release, not this. */
  cmsVersion: siteVersionSchema.nullable(),
  /** The id of a row of the stack's table of generations. */
  generation: generationId.nullable(),
  /** The generation seen from outside, for a site without files. */
  publicGeneration: generationId.nullable(),
  /** What reading the version and the layout found. */
  limit: z.enum(siteLimits).nullable(),
  /** From the header of the site alone; the version of the copy lies in `probe.php`. */
  phpSeen: phpVersion.nullable(),
  adminPath: adminPathSchema.nullable(),
  /** The closed list of the adapter, read by its own schema. Replaced as a whole by a write. */
  extras: extrasSchema,
  probe: z
    .strictObject({
      status: z.enum(['pending', 'passed', 'failed', 'no_database', 'unproved']),
      php: phpVersion.nullable(),
      reason: hostingText(48).nullable(),
      at: z.iso.datetime().max(32),
    })
    .nullable(),
})
export type SiteStackFacts = z.infer<typeof siteStackFactsSchema>

/** Nothing known yet: what a new site and a record of another shape read as. */
export const emptySiteStackFacts: SiteStackFacts = Object.freeze({
  v: 1,
  cmsVersion: null,
  generation: null,
  publicGeneration: null,
  limit: null,
  phpSeen: null,
  adminPath: null,
  extras: Object.freeze({}),
  probe: null,
})

/** One write: any keys but the version of the record, which the writer adds itself. */
export const siteStackFactsPatchSchema = siteStackFactsSchema.omit({ v: true }).partial()
export type SiteStackFactsPatch = z.infer<typeof siteStackFactsPatchSchema>

/**
 * The row of the database as a record: the keys it lacks are filled with the empty values, so a
 * record written in parts reads whole (Р4); a row of another shape reads as the empty record.
 */
export function siteStackFactsOf(stored: unknown): SiteStackFacts {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    return emptySiteStackFacts
  const parsed = siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, ...stored })
  return parsed.success ? parsed.data : emptySiteStackFacts
}
