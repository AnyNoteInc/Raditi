import { z } from 'zod'

// A SQL dump on the site's own file source as the source of a preview's database copy (owner's
// decision of 26.10.2026, «Из дампа в корне FTP»): for a site whose database answers only on the
// hosting itself. The owner names the file; nothing is taken by a pattern — a hosting keeps
// broken and half-made dumps next to good ones. The dump is loaded into a temporary database of
// the platform and copied from it exactly as from a live database (spec §8, Р15): the same
// allowlist and synthetic users, nothing of it sent anywhere else.

/** What a dump may weigh and how long its load may take. */
export const databaseDumpLimits = Object.freeze({
  /** The file as it lies on the hosting, compressed or not. */
  fileBytes: 512 * 1024 * 1024,
  /** What a compressed dump may expand to: what the temporary database is given at most. */
  loadBytes: 1024 * 1024 * 1024,
  pathChars: 512,
  /** The download over the file source and the load into the temporary database together. */
  loadMs: 30 * 60_000,
})

const SEGMENT = /^[^/\\\p{Cc}]+$/u
const DUMP_FILE = /\.sql(\.gz)?$/i

/**
 * The path of a dump relative to the login folder of the file source: `/` between segments, no
 * `..` or `.` segment, no leading `/`, the file name ending in `.sql` or `.sql.gz`.
 */
export const databaseDumpPathSchema = z
  .string()
  .trim()
  .min(5)
  .max(databaseDumpLimits.pathChars)
  .refine((path) => {
    const segments = path.split('/')
    return (
      segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..') &&
      DUMP_FILE.test(segments.at(-1) ?? '')
    )
  }, 'expected the path of a .sql or .sql.gz file below the login folder')

/** Where a dump lies: the folder the file source opens at, the file in it, and its compression. */
export interface DatabaseDumpLocation {
  /** `.` — the login folder itself. */
  folder: string
  file: string
  gzip: boolean
}

export function databaseDumpLocation(path: string): DatabaseDumpLocation {
  const parsed = databaseDumpPathSchema.parse(path)
  const segments = parsed.split('/')
  const file = segments.pop()!
  return {
    folder: segments.length === 0 ? '.' : segments.join('/'),
    file,
    gzip: /\.gz$/i.test(file),
  }
}
