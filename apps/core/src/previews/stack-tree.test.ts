import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { siteFolderOf, stackTreeOf, type StackBuild } from '../testing/stack-preview.ts'

// The tree of a build for the harness of М2 (docs/plan/62-slices/e3.md, Э3.15): a row of
// cms-archives.json may name the folder of its archive that holds the site (`tree`), and that
// folder must be a directory of the unpacked tree, not a link out of it.
const table = JSON.parse(
  readFileSync(
    new URL('../../../../infra/dev/stack-verify/cms-archives.json', import.meta.url),
    'utf8',
  ),
) as Record<string, { sha256: string; tree?: string }>
// stackTreeOf reads the archive and its PHP only.
const wordpress: StackBuild = {
  archive: 'wordpress-7.1.2',
  php: '8.3',
  generation: '',
  version: '7.1.2',
}

describe('stackTreeOf', () => {
  let directory: string
  let before: string | undefined
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'raditi-stack-tree-'))
    before = process.env.RADITI_CMS_DIR
    process.env.RADITI_CMS_DIR = directory
  })
  afterEach(() => {
    if (before === undefined) delete process.env.RADITI_CMS_DIR
    else process.env.RADITI_CMS_DIR = before
    rmSync(directory, { recursive: true, force: true })
  })

  const unpacked = (): string => {
    const tree = join(directory, wordpress.archive, 'tree')
    mkdirSync(tree, { recursive: true })
    writeFileSync(
      join(directory, wordpress.archive, 'tree.sha256'),
      `${table[wordpress.archive]?.sha256}\n`,
    )
    return tree
  }

  it('answers the folder the row names inside the tree', () => {
    expect(table[wordpress.archive]?.tree).toBe('wordpress')
    const tree = unpacked()
    mkdirSync(join(tree, 'wordpress'))
    expect(stackTreeOf(wordpress)).toBe(join(tree, 'wordpress'))
  })

  it('refuses a named folder the archive does not hold', () => {
    unpacked()
    expect(() => stackTreeOf(wordpress)).toThrow(/holds no folder wordpress/)
  })

  it('refuses a named folder that is a symbolic link out of the tree', () => {
    const tree = unpacked()
    const host = join(directory, 'host')
    mkdirSync(host)
    writeFileSync(join(host, 'id_rsa'), 'not a key of this machine\n')
    symlinkSync(host, join(tree, 'wordpress'))
    expect(() => stackTreeOf(wordpress)).toThrow(/leads out of its tree/)
  })
})

describe('siteFolderOf', () => {
  let tree: string
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'raditi-site-folder-'))
  })
  afterEach(() => rmSync(tree, { recursive: true, force: true }))

  it('takes plain names joined by / and nothing that leaves the tree', () => {
    mkdirSync(join(tree, 'ocStore-3.0.3.7', 'upload'), { recursive: true })
    expect(siteFolderOf(tree, 'ocStore-3.0.3.7/upload', 'x')).toBe(
      join(tree, 'ocStore-3.0.3.7', 'upload'),
    )
    for (const name of ['', '.', '..', '/upload', 'upload/', 'a/../upload', 'a//b'])
      expect(() => siteFolderOf(tree, name, 'x'), name).toThrow(/plain names/)
    const outside = mkdtempSync(join(tmpdir(), 'raditi-site-outside-'))
    try {
      mkdirSync(join(tree, 'outer'))
      symlinkSync(outside, join(tree, 'outer', 'upload'))
      expect(() => siteFolderOf(tree, 'outer/upload', 'x')).toThrow(/leads out of its tree/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
