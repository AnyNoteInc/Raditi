import { describe, expect, it } from 'vitest'

import { databaseDumpLocation, databaseDumpPathSchema } from './database-dump.ts'

describe('the path of a database dump', () => {
  it('takes a .sql or .sql.gz file below the login folder', () => {
    for (const path of [
      'backup-2026-08-30-084705-25d7e703c1a20737.sql',
      'dumps/site.SQL',
      'старое/база.sql.gz',
    ])
      expect(databaseDumpPathSchema.safeParse(path).success).toBe(true)
  })

  it('refuses a way out of the login folder, an absolute path and another file', () => {
    for (const path of [
      '../backup.sql',
      'a/../backup.sql',
      './backup.sql',
      '/backup.sql',
      'a//backup.sql',
      'a\\backup.sql',
      'backup-2026-08-17-1245.sql.CORRUPTED-DO-NOT-RESTORE',
      'backup.sql.zip',
      'line\nbreak.sql',
      '',
    ])
      expect(databaseDumpPathSchema.safeParse(path).success, path).toBe(false)
  })

  it('names the folder the source opens at, the file and its compression', () => {
    expect(databaseDumpLocation('backup.sql')).toEqual({
      folder: '.',
      file: 'backup.sql',
      gzip: false,
    })
    expect(databaseDumpLocation(' dumps/old/site.sql.GZ ')).toEqual({
      folder: 'dumps/old',
      file: 'site.sql.GZ',
      gzip: true,
    })
  })
})
