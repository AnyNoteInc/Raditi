/* global Buffer, console, process, setInterval, setTimeout, clearTimeout, URLSearchParams */
import { request } from 'node:http'

const mainPrefix = 'io.raditi.sandbox.'
const gatewayPrefix = 'io.raditi.gateway.'
const idPattern = /^[a-f0-9]{64}$/
const resourcePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export function dockerClient(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || /[\0\r\n]/.test(socketPath))
    throw new Error('Watchdog requires a local Docker Unix socket')
  return async (method, path) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method, path, agent: false }, (response) => {
        const chunks = []
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Docker response limit exceeded'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          if (method === 'DELETE' && response.statusCode === 404) return resolve(null)
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new Error('Docker watchdog request failed'))
          try {
            resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null)
          } catch {
            reject(new Error('Invalid Docker watchdog response'))
          }
        })
      })
      const timer = setTimeout(
        () => req.destroy(new Error('Docker watchdog request timed out')),
        5_000,
      )
      req.on('close', () => clearTimeout(timer))
      req.on('error', reject)
      req.end()
    })
}

function listPath(kind, prefix) {
  const query = new URLSearchParams({
    all: '1',
    filters: JSON.stringify({ label: [`${prefix}owner=raditi`, `${prefix}protocol=1`] }),
  })
  return `/${kind}?${query}`
}

function expired(labels, prefix, now) {
  const deadline = Number(labels?.[`${prefix}deadline`])
  return (
    labels?.[`${prefix}owner`] === 'raditi' &&
    labels?.[`${prefix}protocol`] === '1' &&
    Number.isSafeInteger(deadline) &&
    deadline > 0 &&
    deadline <= now
  )
}

/** Independent from the core/runner process: hard deadline cleanup only, never lease guessing. */
export async function reapExpired(client, now = Date.now()) {
  const mains = await client('GET', listPath('containers/json', mainPrefix))
  let removed = 0
  let failed = false
  const blocked = new Set()
  for (const item of mains) {
    const labels = item.Labels
    if (!expired(labels, mainPrefix, now) || !idPattern.test(item.Id)) continue
    const task = labels[`${mainPrefix}taskId`]
    const turn = labels[`${mainPrefix}turn`]
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task ?? '') ||
      !/^[1-9]\d*$/.test(turn ?? '') ||
      !item.Names?.includes(`/raditi-turn-${task}-${turn}`)
    )
      continue
    try {
      await client('DELETE', `/containers/${item.Id}?force=1&v=1`)
      removed++
    } catch {
      failed = true
      const resourceId = labels[`${mainPrefix}gatewayId`]
      if (resourcePattern.test(resourceId ?? '')) blocked.add(resourceId)
    }
  }
  // One failed removal must not starve other expired turns. Preserve only its dependencies.
  const gateways = await client('GET', listPath('containers/json', gatewayPrefix))
  for (const item of gateways) {
    if (
      !expired(item.Labels, gatewayPrefix, now) ||
      !idPattern.test(item.Id) ||
      !resourcePattern.test(item.Labels[`${gatewayPrefix}resourceId`] ?? '') ||
      !['guard', 'proxy', 'firewall'].includes(item.Labels[`${gatewayPrefix}role`]) ||
      blocked.has(item.Labels[`${gatewayPrefix}resourceId`])
    )
      continue
    try {
      await client('DELETE', `/containers/${item.Id}?force=1&v=1`)
      removed++
    } catch {
      failed = true
      blocked.add(item.Labels[`${gatewayPrefix}resourceId`])
    }
  }
  const networks = await client('GET', listPath('networks', gatewayPrefix))
  for (const item of networks) {
    if (
      !expired(item.Labels, gatewayPrefix, now) ||
      !idPattern.test(item.Id) ||
      !resourcePattern.test(item.Labels[`${gatewayPrefix}resourceId`] ?? '') ||
      item.Labels[`${gatewayPrefix}role`] !== 'network' ||
      blocked.has(item.Labels[`${gatewayPrefix}resourceId`])
    )
      continue
    try {
      await client('DELETE', `/networks/${item.Id}`)
      removed++
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('Some expired sandbox resources could not be removed')
  return removed
}

if (process.argv[1]?.endsWith('/watchdog.mjs')) {
  const client = dockerClient(process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock')
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await reapExpired(client)
    } catch {
      console.error('Sandbox deadline watchdog failed; retrying')
    } finally {
      busy = false
    }
  }
  void tick()
  setInterval(tick, 1_000)
}
