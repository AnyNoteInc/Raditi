// The platform images (apps/*/Dockerfile): pinned bases, pnpm from its version and turbo from the
// lockfile, a non-root runtime, and the git that publication needs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const dockerfiles = {
  web: readFileSync(new URL('apps/web/Dockerfile', root), 'utf8'),
  orchestrator: readFileSync(new URL('apps/orchestrator/Dockerfile', root), 'utf8'),
}
const DIGEST = /@sha256:[0-9a-f]{64}$/

/** Instructions without comments, continuation lines joined. */
const instructions = (text) =>
  text
    .replace(/^\s*#.*\n/gm, '')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => line.trim())

/** The instructions of one stage, up to the next FROM. */
function stage(text, name) {
  const lines = instructions(text)
  const start = lines.findIndex((line) => new RegExp(`^FROM \\S+ AS ${name}$`).test(line))
  assert.notEqual(start, -1, `stage ${name} is missing`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('FROM '))
  return lines.slice(start, end === -1 ? undefined : end)
}

for (const [app, text] of Object.entries(dockerfiles)) {
  const lines = instructions(text)

  test(`${app}: every base image is pinned by digest`, () => {
    const args = Object.fromEntries(
      lines
        .map((line) => /^ARG (\w+_IMAGE)=(\S+)$/.exec(line))
        .filter(Boolean)
        .map(([, name, value]) => [name, value]),
    )
    for (const image of Object.values(args)) assert.match(image, DIGEST)
    const stages = []
    for (const line of lines.filter((line) => line.startsWith('FROM '))) {
      const [, base, name] = /^FROM (\S+)(?: AS (\S+))?$/.exec(line) ?? []
      const arg = /^\$\{(\w+)\}$/.exec(base)?.[1]
      if (arg) assert.ok(args[arg], `${base} has no pinned default`)
      else if (!stages.includes(base)) assert.match(base, DIGEST)
      if (name) stages.push(name)
    }
  })

  test(`${app}: pnpm is pinned, turbo comes from the frozen lockfile`, () => {
    const code = lines.join('\n')
    assert.doesNotMatch(code, /corepack|pnpm dlx|npx /)
    assert.match(code, /npm install --global pnpm@\d+\.\d+\.\d+ /)
    const install = code.indexOf('pnpm install --frozen-lockfile')
    const prune = code.indexOf('pnpm exec turbo prune')
    assert.ok(install !== -1 && prune > install)
  })

  test(`${app}: the runtime runs as a non-root user`, () => {
    const runtime = stage(text, 'runtime')
    assert.equal(runtime.filter((line) => line.startsWith('USER ')).at(-1), 'USER 10001:10001')
    assert.ok(runtime.includes('ENTRYPOINT ["node"]'))
  })
}

test('orchestrator: the build fails without git 2.47, which publication needs', () => {
  const runtime = stage(dockerfiles.orchestrator, 'runtime').join('\n')
  assert.match(runtime, /git --version \| awk .*v\[2\] >= 47/)
  assert.match(runtime, /COPY --from=gitleaks \/usr\/bin\/gitleaks \/usr\/local\/bin\/gitleaks/)
})

test('orchestrator: migrate runs the Prisma CLI of @repo/db as its own uid', () => {
  const migrate = stage(dockerfiles.orchestrator, 'migrate')
  assert.ok(migrate.includes('WORKDIR /repo/packages/db'))
  assert.ok(migrate.includes('USER 10004:10004'))
})
