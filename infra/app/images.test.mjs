// The platform images (apps/{web,core,llm,mcp,preview,runner,browser}/Dockerfile): pinned bases, pnpm from its version and turbo from the
// lockfile, a non-root runtime, and the git that publication needs. The third-party images of the
// app VM: verify:edge runs exactly the digests that env.example deploys.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const dockerfiles = {
  web: readFileSync(new URL('apps/web/Dockerfile', root), 'utf8'),
  core: readFileSync(new URL('apps/core/Dockerfile', root), 'utf8'),
  llm: readFileSync(new URL('apps/llm/Dockerfile', root), 'utf8'),
  mcp: readFileSync(new URL('apps/mcp/Dockerfile', root), 'utf8'),
  preview: readFileSync(new URL('apps/preview/Dockerfile', root), 'utf8'),
  runner: readFileSync(new URL('apps/runner/Dockerfile', root), 'utf8'),
  browser: readFileSync(new URL('apps/browser/Dockerfile', root), 'utf8'),
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

for (const app of ['llm', 'mcp', 'preview', 'runner', 'browser']) {
  test(`${app}: its own image prunes and builds its own app, and carries no git or gitleaks`, () => {
    const code = instructions(dockerfiles[app]).join('\n')
    assert.match(code, new RegExp(`turbo prune ${app} --docker`))
    assert.match(code, new RegExp(`pnpm --filter ${app} build`))
    assert.match(code, new RegExp(`WORKDIR /app/apps/${app}$`, 'm'))
    // Only core publishes to git and scans for secrets; the other processes hold no such tools.
    assert.doesNotMatch(code, /gitleaks|apt-get install[^\n]*\bgit\b/)
  })
}

test('core: the build fails without git 2.47, which publication needs', () => {
  const runtime = stage(dockerfiles.core, 'runtime').join('\n')
  assert.match(runtime, /git --version \| awk .*v\[2\] >= 47/)
  assert.match(runtime, /COPY --from=gitleaks \/usr\/bin\/gitleaks \/usr\/local\/bin\/gitleaks/)
})

test('core: migrate runs the Prisma CLI of @repo/db as its own uid', () => {
  const migrate = stage(dockerfiles.core, 'migrate')
  assert.ok(migrate.includes('WORKDIR /repo/packages/db'))
  assert.ok(migrate.includes('USER 10004:10004'))
})

test('verify:edge runs the Traefik, PostgreSQL and Redis digests that the app VM deploys', () => {
  const digest = (image) => /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1]
  const example = readFileSync(new URL('infra/app/env.example', root), 'utf8')
  const verify = readFileSync(new URL('infra/app/verify-edge.mjs', root), 'utf8')
  for (const name of ['TRAEFIK_IMAGE', 'POSTGRES_IMAGE', 'REDIS_IMAGE']) {
    const deployed = digest(new RegExp(`^${name}=(\\S+)$`, 'm').exec(example)?.[1] ?? '')
    const verified = digest(new RegExp(`const ${name} =\\s+'([^']+)'`).exec(verify)?.[1] ?? '')
    assert.ok(deployed, `${name} in env.example is not pinned`)
    assert.equal(verified, deployed, name)
  }
})
