import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

interface LockedPackage {
  version: string
  resolved?: string
  integrity?: string
  dependencies?: Record<string, string>
}

/** The sandbox image installs the agent CLIs from this lockfile (infra/sandbox/Dockerfile). */
describe('agent CLI lockfile', () => {
  const manifest = JSON.parse(read('../cli/package.json')) as {
    dependencies: Record<string, string>
  }
  const lock = JSON.parse(read('../cli/package-lock.json')) as {
    lockfileVersion: number
    packages: Record<string, LockedPackage>
  }
  const runtime = read('../../../infra/sandbox/Dockerfile')
    .split(/^FROM /m)
    .find((stage) => stage.startsWith('base AS runtime\n'))!

  it('pins both CLIs to exact versions', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@moonshot-ai/kimi-code',
      '@openai/codex',
    ])
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
    }
    expect(lock.packages['']?.dependencies).toEqual(manifest.dependencies)
  })

  it('locks every package, transitive ones included, to a registry tarball and its sha512', () => {
    expect(lock.lockfileVersion).toBe(3)
    const locked = Object.entries(lock.packages).filter(([path]) => path !== '')
    expect(locked.length).toBeGreaterThan(2)
    for (const [path, entry] of locked) {
      expect(path).toMatch(/^node_modules\//)
      expect(entry.version, path).toMatch(/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/)
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\/[^\s]+\.tgz$/)
      expect(entry.integrity, path).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    }
  })

  it('is what the sandbox runtime installs, without lifecycle scripts', () => {
    expect(runtime).toContain(
      'COPY packages/agent-drivers/cli/package.json packages/agent-drivers/cli/package-lock.json ',
    )
    expect(runtime).toMatch(/npm ci --ignore-scripts /)
    // A bare install resolves ranges at build time and runs package scripts as root.
    expect(runtime).not.toMatch(/npm (install|i|add|exec)\b|npx /)
    // The build itself fails when the lockfile no longer holds the verified versions.
    const pinned = Object.entries(manifest.dependencies)
      .map(([name, version]) => `${name}@${version}`)
      .sort()
    const checked = [...runtime.matchAll(/npm ls (\S+@\d+\.\d+\.\d+)(?=\s)/g)].map(
      (match) => match[1],
    )
    expect(checked.sort()).toEqual(pinned)
  })
})
