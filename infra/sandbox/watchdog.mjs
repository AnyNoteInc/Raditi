/* global Buffer, console, process, setInterval, setTimeout, clearTimeout, URLSearchParams */
import { request } from 'node:http'

const mainPrefix = 'io.raditi.sandbox.'
const gatewayPrefix = 'io.raditi.gateway.'
const previewPrefix = 'io.raditi.preview.'
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

/** The preview of a resource and its deadline; null for anything that is not ours. */
function previewOf(labels) {
  if (labels?.[`${previewPrefix}owner`] !== 'raditi' || labels[`${previewPrefix}protocol`] !== '1')
    return null
  const id = labels[`${previewPrefix}id`]
  const deadline = Number(labels[`${previewPrefix}deadline`])
  if (!resourcePattern.test(id ?? '') || !Number.isSafeInteger(deadline) || deadline <= 0)
    return null
  return { id, deadline }
}

/**
 * Previews of dialogs (docs/plan/53-chat-preview-release.md, Р18) live until the latest deadline
 * of any of their resources: labels cannot change, so core extends a preview with a new lease
 * container. Past it, everything of the preview goes — containers, then networks, then volumes —
 * and only by the names the runtime gives them.
 */
export async function reapExpiredPreviews(client, now = Date.now()) {
  const containers = await client('GET', listPath('containers/json', previewPrefix))
  const networks = await client('GET', listPath('networks', previewPrefix))
  const volumes = (await client('GET', listPath('volumes', previewPrefix)))?.Volumes ?? []
  const latest = new Map()
  for (const item of [...containers, ...networks, ...volumes]) {
    const preview = previewOf(item.Labels)
    if (preview) latest.set(preview.id, Math.max(latest.get(preview.id) ?? 0, preview.deadline))
  }
  const expiredPreview = (labels) => {
    const preview = previewOf(labels)
    return preview && latest.get(preview.id) <= now ? preview.id : null
  }
  let removed = 0
  let failed = false
  const blocked = new Set()
  for (const item of containers) {
    const id = expiredPreview(item.Labels)
    if (!id || !idPattern.test(item.Id)) continue
    if (!item.Names?.some((name) => name.startsWith(`/raditi-preview-${id}-`))) continue
    try {
      await client('DELETE', `/containers/${item.Id}?force=1&v=1`)
      removed++
    } catch {
      failed = true
      blocked.add(id)
    }
  }
  for (const item of networks) {
    const id = expiredPreview(item.Labels)
    if (!id || blocked.has(id) || !idPattern.test(item.Id)) continue
    if (![`raditi-preview-${id}`, `raditi-preview-${id}-browser`].includes(item.Name)) continue
    try {
      await client('DELETE', `/networks/${item.Id}`)
      removed++
    } catch {
      failed = true
      blocked.add(id)
    }
  }
  for (const item of volumes) {
    const id = expiredPreview(item.Labels)
    if (!id || blocked.has(id)) continue
    if (![`rpv-${id}-files`, `rpv-${id}-db`].includes(item.Name)) continue
    try {
      await client('DELETE', `/volumes/${item.Name}`)
      removed++
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('Some expired preview resources could not be removed')
  return removed
}

if (process.argv[1]?.endsWith('/watchdog.mjs')) {
  const client = dockerClient(process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock')
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    // One kind failing must not hold back the other.
    for (const [reap, name] of [
      [reapExpired, 'Sandbox'],
      [reapExpiredPreviews, 'Preview'],
    ])
      try {
        await reap(client)
      } catch {
        console.error(`${name} deadline watchdog failed; retrying`)
      }
    busy = false
  }
  void tick()
  setInterval(tick, 1_000)
}
