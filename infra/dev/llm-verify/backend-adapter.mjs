/* global Headers */
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

import { codexBackend } from '../../../packages/llm-backends/src/index.ts'

const probeUrl = 'https://chatgpt.com/backend-api/wham/usage'
const responseLimit = 64 * 1024
const route = Object.freeze({ method: 'POST', path: '/codex/responses' })
const safeError = (code) => Object.assign(new Error(code), { code })

function checkedCredential(value) {
  const parsed = codexBackend.credentialSchema.safeParse(value)
  if (!parsed.success) throw safeError('ADAPTER_CREDENTIAL_INVALID')
  const expires = codexBackend.credentialMetadata(parsed.data).accessExpiresAt
  if (expires !== null && expires.getTime() <= Date.now()) throw safeError('AUTH_EXPIRED')
  return parsed.data
}

function responseHeaders(source) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
  }
  return headers
}

/** This live-test transport cannot refresh, revoke, log in, or send a generation prompt. */
function probeTransport(request, agent) {
  return {
    request(outgoing, { signal }) {
      if (outgoing.url !== probeUrl || outgoing.method !== 'GET' || outgoing.body !== undefined)
        return Promise.reject(safeError('ADAPTER_PROBE_FAILED'))
      return new Promise((resolve, reject) => {
        let client,
          incoming,
          settled = false
        const fail = () => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', fail)
          // Reject before destroy: injected transports may emit errors synchronously.
          reject(safeError('ADAPTER_PROBE_FAILED'))
          incoming?.destroy()
          client?.destroy()
        }
        signal.addEventListener('abort', fail, { once: true })
        if (signal.aborted) {
          fail()
          return
        }
        try {
          client = request(
            probeUrl,
            {
              method: 'GET',
              headers: Object.fromEntries(outgoing.headers),
              signal,
              ...(agent ? { agent } : {}),
            },
            (response) => {
              incoming = response
              response.on('error', fail)
              response.on('aborted', fail)
              const status = response.statusCode ?? 502
              const encoding = response.headers['content-encoding']
              if ((status >= 300 && status < 400) || (encoding && encoding !== 'identity')) {
                fail()
                return
              }
              const declaredSize = response.headers['content-length']
              if (
                declaredSize !== undefined &&
                (!/^\d+$/.test(declaredSize) || Number(declaredSize) > responseLimit)
              ) {
                fail()
                return
              }
              const chunks = []
              let bytes = 0
              response.on('data', (chunk) => {
                if (settled) return
                bytes += chunk.length
                if (bytes > responseLimit) {
                  fail()
                  return
                }
                chunks.push(chunk)
              })
              response.on('end', () => {
                if (settled) return
                try {
                  const headers = responseHeaders(response.headers)
                  const body = Buffer.concat(chunks)
                  settled = true
                  signal.removeEventListener('abort', fail)
                  resolve({ status, headers, body })
                } catch {
                  fail()
                }
              })
              response.on('close', () => {
                if (!settled) fail()
              })
            },
          )
          client.on('error', fail)
          client.end()
        } catch {
          fail()
        }
      })
    },
  }
}

/** No filesystem access, credential persistence, or automatic authentication mutations. */
export function createCodexAdapter({ model, request = httpsRequest }) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+$/.test(model))
    throw safeError('ADAPTER_REQUEST_REJECTED')
  const identity = Object.freeze({ installationId: randomUUID() })
  const context = Object.freeze({
    model,
    reasoningEffort: 'low',
    cacheKey: `rdt_${createHash('sha256').update(`raditi:${randomUUID()}`).digest('hex').slice(0, 32)}`,
  })
  return {
    prepare({ body, headers, credential }) {
      const value = checkedCredential(credential)
      try {
        const normalized = codexBackend.normalizeBody(route, body, context)
        const upstream = codexBackend.upstream(route, normalized, headers, value, identity)
        return {
          ...upstream,
          body: normalized.body,
          meter: codexBackend.usageMeter(),
          normalized: { estInputTokens: normalized.estInputTokens },
        }
      } catch (error) {
        const rejected = safeError('ADAPTER_REQUEST_REJECTED')
        const details = error?.details
        if (
          error?.code === 'BAD_REQUEST' &&
          details &&
          typeof details.reason === 'string' &&
          /^[a-z_]{1,32}$/.test(details.reason) &&
          typeof details.path === 'string' &&
          /^[A-Za-z_.[\]-]{1,64}$/.test(details.path)
        )
          rejected.policy = { reason: details.reason, path: details.path }
        throw rejected
      }
    },
    probe({ credential, agent }) {
      const value = checkedCredential(credential)
      // The backend rejects when the provider gave no answer about the account.
      return codexBackend.probe(value, identity, probeTransport(request, agent)).catch(() => {
        throw safeError('USAGE_PROBE_FAILED')
      })
    },
    classify: (...args) => codexBackend.classify(...args),
    windowsFromHeaders: (headers) => codexBackend.windowsFromHeaders(headers),
  }
}
