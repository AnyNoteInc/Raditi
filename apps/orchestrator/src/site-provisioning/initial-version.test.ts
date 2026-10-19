import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runProcess } from '../git-workspace/process.ts'
import { fixtureGit } from '../testing/site-import.ts'
import { InitialVersionGit } from './initial-version.ts'
import type { TakenFile } from './tree-walk.ts'

// Real processes; a test may still change how one command is started.
vi.mock('../git-workspace/process.ts', async (importOriginal) => {
  const actual = await importOriginal<{ runProcess: typeof runProcess }>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})
const realRunProcess = vi.mocked(runProcess).getMockImplementation()!

const roots: string[] = []
afterEach(async () => {
  vi.mocked(runProcess).mockImplementation(realRunProcess)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function copies(
  files: Record<string, string>,
): Promise<{ root: string; taken: TakenFile[] }> {
  const root = await mkdtemp(join(tmpdir(), 'raditi-initial-version-test-'))
  roots.push(root)
  const taken: TakenFile[] = []
  for (const [index, [path, content]] of Object.entries(files).entries()) {
    const blob = join(root, `blob-${index}`)
    await writeFile(blob, content)
    taken.push({ path, blob, bytes: Buffer.byteLength(content) })
  }
  return { root, taken }
}

const versions = (root: string) =>
  new InitialVersionGit({
    provider: { issueCredentials: vi.fn() },
    transport: { kind: 'local-test', root },
  })

describe('InitialVersionGit.buildCommit', () => {
  it('leaves out a path HFS+ reads as .git on every platform, and counts it', async () => {
    // A git built for Linux has core.protectHFS off. Set off in front of every option, as such
    // a build has it: the trusted options must turn it on again for the alias to be refused.
    vi.mocked(runProcess).mockImplementation(async (binary, argv, options) =>
      realRunProcess(
        binary,
        ['-c', 'core.protectHFS=false', '-c', 'core.protectNTFS=false', ...argv],
        options,
      ),
    )
    const { root, taken } = await copies({
      'index.php': '<?php // synthetic\n',
      // Past the path rules of the walker and the publication: only git itself knows it.
      '.g\u200cit/config': '[core]\n\thooksPath = /tmp\n',
    })
    const built = await versions(root).buildCommit(
      root,
      taken,
      'site-1',
      new Date('2026-10-17T10:00:00Z'),
    )

    expect(built.dropped).toBe(1)
    expect(built.files.map((file) => file.path)).toEqual(['index.php'])
    const tree = await fixtureGit(join(root, 'repo'), 'ls-tree', '-r', '--name-only', built.sha)
    expect(tree.trim().split('\n')).toEqual(['index.php'])
  })
})
