import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OPENCODE_CLI_VERSION } from './opencode.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/**
 * A bare install by any of the package managers, as a command of its own: it resolves ranges at
 * build time and runs package scripts as root. A path that ends in the name of one (`…/pnpx`) is
 * no command.
 */
const bareInstall =
  /(?:^|[\s;&|(])(?:p?npm|yarn) (?:install|i|add|exec|dlx)\b|(?:^|[\s;&|(])p?npx /m

interface LockedPackage {
  version: string
  resolved?: string
  integrity?: string
  dependencies?: Record<string, string>
  hasInstallScript?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

/** The sandbox image installs the agent CLI from this lockfile (infra/sandbox/Dockerfile). */
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

  it('pins every CLI to an exact version', () => {
    // The agent CLI, the browser skill's MCP server (owner's request of 26.10.2026) and the pnpm
    // of the agent's checks (spec §20, «Инструменты песочницы — решения 19.11.2026», ИП3).
    expect(Object.keys(manifest.dependencies)).toEqual(['@playwright/mcp', 'opencode-ai', 'pnpm'])
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
    expect(runtime).not.toMatch(bareInstall)
    // The build itself fails when the lockfile no longer holds the verified versions.
    const pinned = Object.entries(manifest.dependencies)
      .map(([name, version]) => `${name}@${version}`)
      .sort()
    const checked = [...runtime.matchAll(/npm ls (\S+@\d+\.\d+\.\d+)(?=\s)/g)].map(
      (match) => match[1],
    )
    expect(checked.sort()).toEqual(pinned)
  })

  it('knows a bare install of every package manager, and finds none in the runtime stage', () => {
    // As a line of the stage's RUN would hold it.
    const line = (command: string) => `    && ${command} \\\n`
    for (const command of [
      'npm install --global some-tool',
      'npm i -g some-tool',
      'npm exec some-tool',
      'pnpm add -g some-tool',
      'pnpm install',
      'pnpm i --frozen-lockfile',
      'pnpm dlx some-tool',
      'npx some-tool',
      'pnpx some-tool',
      'yarn add some-tool',
      'yarn dlx some-tool',
      'cd /tmp && pnpm install',
      '(npm install)',
    ])
      expect(line(command), command).toMatch(bareInstall)
    expect('npx some-tool\n').toMatch(bareInstall)
    // What the stage runs: the clean install of the lockfile, its checks, the links of the bins.
    for (const command of [
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm ls pnpm@12.6.0',
      'npm cache clean --force',
      'ln -s /usr/local/lib/raditi/agent-clis/node_modules/pnpm/pnpx /usr/local/bin/pnpx',
    ])
      expect(line(command), command).not.toMatch(bareInstall)
    expect(runtime).toContain(
      'ln -s /usr/local/lib/raditi/agent-clis/node_modules/pnpm/pnpx /usr/local/bin/pnpx',
    )
    expect(runtime).not.toMatch(bareInstall)
  })

  it('is the version the driver declares to the planner', () => {
    expect(manifest.dependencies['opencode-ai']).toBe(OPENCODE_CLI_VERSION)
  })

  it('links the OpenCode binary of the image architecture, never the launcher stub', () => {
    const version = manifest.dependencies['opencode-ai']
    // The launcher package only holds a stub that its postinstall would replace; no lifecycle
    // script runs, so the image links the platform package's own binary.
    expect(lock.packages['node_modules/opencode-ai']).toMatchObject({ hasInstallScript: true })
    for (const platform of ['opencode-linux-arm64', 'opencode-linux-x64-baseline'])
      expect(lock.packages[`node_modules/${platform}`]?.version).toBe(version)
    expect(runtime).toMatch(/arm64\) opencode=opencode-linux-arm64 ;;/)
    // The baseline build runs on an x64 CPU without AVX2; the other x64 package leaves the layer.
    expect(runtime).toMatch(
      /amd64\) opencode=opencode-linux-x64-baseline; rm -rf node_modules\/opencode-linux-x64 ;;/,
    )
    expect(runtime).toContain('test -x "node_modules/${opencode}/bin/opencode"')
    expect(runtime).toContain(
      'ln -s "/usr/local/lib/raditi/agent-clis/node_modules/${opencode}/bin/opencode" /usr/local/bin/opencode',
    )
    expect(runtime).not.toMatch(/opencode\.exe|node_modules\/opencode-ai\/bin/)
  })

  it('puts the pnpm binary of the image architecture over its launcher placeholder', () => {
    const version = manifest.dependencies.pnpm
    // The launcher's install script would put the binary of its platform package in place of its
    // `pnpm` placeholder; no lifecycle script runs, so the image does what the script does.
    expect(lock.packages['node_modules/pnpm']).toMatchObject({ hasInstallScript: true })
    for (const [platform, cpu] of [
      ['@pnpm/exe.linux-arm64', 'arm64'],
      ['@pnpm/exe.linux-x64', 'x64'],
    ] as const)
      expect(lock.packages[`node_modules/${platform}`], platform).toMatchObject({
        version,
        os: ['linux'],
        cpu: [cpu],
        libc: ['glibc'],
      })
    expect(runtime).toMatch(
      /arm64\) pnpm=@pnpm\/exe\.linux-arm64; rm -rf node_modules\/@pnpm\/exe\.linux-arm64-musl ;;/,
    )
    expect(runtime).toMatch(
      /amd64\) pnpm=@pnpm\/exe\.linux-x64; rm -rf node_modules\/@pnpm\/exe\.linux-x64-musl ;;/,
    )
    // No binary of another platform stays in the layer.
    expect(runtime).toContain('test "$(echo node_modules/@pnpm/exe.*)" = "node_modules/${pnpm}"')
    expect(runtime).toContain('test -x "node_modules/${pnpm}/pnpm"')
    // A hard link, as the script makes it: next to it the binary finds the launcher's dist/.
    expect(runtime).toContain('ln -f "node_modules/${pnpm}/pnpm" node_modules/pnpm/pnpm')
    for (const bin of ['pnpm', 'pnpx'])
      expect(runtime).toContain(
        `ln -s /usr/local/lib/raditi/agent-clis/node_modules/pnpm/${bin} /usr/local/bin/${bin}`,
      )
  })

  it('installs the Chromium of the browser skill while building, where the driver looks for it', () => {
    // The Playwright of the locked MCP server downloads its own Chromium build: a turn, which has
    // no way to download, finds it in place.
    expect(lock.packages['node_modules/@playwright/mcp']?.dependencies).toMatchObject({
      'playwright-core': lock.packages['node_modules/playwright-core']?.version,
    })
    expect(runtime).toContain(
      'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \\\n      node node_modules/@playwright/mcp/cli.js install-browser --with-deps --no-shell chromium',
    )
    const driver = read('./opencode.ts')
    expect(driver).toContain("const playwrightBrowsers = '/opt/ms-playwright'")
    expect(driver).toContain(
      "const playwrightMcp = '/usr/local/lib/raditi/agent-clis/node_modules/@playwright/mcp/cli.js'",
    )
  })
})
