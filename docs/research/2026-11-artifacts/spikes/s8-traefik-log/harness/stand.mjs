// The stand of spike s8: whoami as web (:3000) and preview (:8092), Traefik as on the edge.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { docker, NET, publishedPort, rawExchange, sleep, WHOAMI } from './lib.mjs'

export const get = (host, target, extra = '') =>
  `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: spike-s8\r\n${extra}Connection: close\r\n\r\n`

export async function backends() {
  await docker(['network', 'create', NET], { allowFail: true })
  for (const [name, alias, port] of [['spike88-s8-web', 'web', '3000'], ['spike88-s8-preview', 'preview', '8092']]) {
    await docker(['rm', '-f', name], { allowFail: true })
    await docker(['run', '-d', '--name', name, '--network', NET, '--network-alias', alias, WHOAMI, '--port', port])
  }
}

export async function removeBackends() {
  await docker(['rm', '-f', 'spike88-s8-web', 'spike88-s8-preview'], { allowFail: true })
  await docker(['network', 'rm', NET], { allowFail: true })
}

/**
 * Traefik with the repo's hardening of compose (user, read-only root, no capabilities, /tmp
 * tmpfs, limits), the repo flags as `def.flags` changes them and the run's dynamic files.
 */
export async function traefik(RUN, stand, variant, def) {
  const name = `spike88-s8-traefik-${variant}`
  const dir = join(RUN, 'variants', variant)
  mkdirSync(dir, { recursive: true })
  cpSync(join(RUN, 'dynamic'), join(dir, 'dynamic'), { recursive: true })
  for (const [file, text] of Object.entries(def.extra ?? {})) writeFileSync(join(dir, 'dynamic', file), text)
  const flags = def.flags(stand.flags)
  writeFileSync(join(dir, 'flags.txt'), `${flags.join('\n')}\n`)
  const env = Object.entries(stand.hosts).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await docker(['rm', '-f', name], { allowFail: true })
  await docker([
    'run', '-d', '--name', name, '--network', NET,
    '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:size=1m,uid=65532,gid=65532,mode=0700',
    ...(def.file ? ['--tmpfs', '/var/log/traefik:size=8m,uid=65532,gid=65532,mode=0700'] : []),
    '--cpus', '0.5', '--memory', '256m', '--pids-limit', '256',
    ...env,
    '-v', `${join(dir, 'dynamic')}:/etc/traefik/dynamic:ro`,
    '-v', `${join(RUN, 'tls')}:/spike-tls:ro`,
    '-v', `${join(RUN, 'secrets')}:/run/raditi:ro`,
    '-p', '127.0.0.1::8000', '-p', '127.0.0.1::8443', '-p', '127.0.0.1::9000',
    stand.image, ...flags,
  ])
  const ports = {
    http: await publishedPort(name, 8000),
    https: await publishedPort(name, 8443),
    internal: await publishedPort(name, 9000),
  }
  for (let i = 0; i < 60; i++) {
    const ping = await fetch(`http://127.0.0.1:${ports.internal}/ping`).then((r) => r.status, () => 0)
    if (ping === 200) break
    await sleep(500)
  }
  // The file provider renders the routes after ping is up: wait until the apex answers.
  const apex = stand.hosts.APP_DOMAIN
  for (let i = 0; i < 60; i++) {
    const answer = await rawExchange({ port: ports.https, servername: apex, request: get(apex, '/__ready') })
    if (answer.status === 200) break
    await sleep(500)
  }
  return { name, ports }
}
