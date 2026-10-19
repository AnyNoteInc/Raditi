import { Buffer } from 'node:buffer'

import type { KvListPage, KvMetadata, SecretStore } from '@repo/domain'
import { z } from 'zod'

import { VaultError } from './errors.ts'
import { vaultHttpLimits } from './limits.ts'
import type { VaultSession } from './session.ts'

type KvStore = Pick<
  SecretStore,
  'kvRead' | 'kvWrite' | 'kvCreateOnce' | 'kvDelete' | 'kvDestroyAll' | 'kvList' | 'kvMetadata'
>
const segment = /^[A-Za-z0-9_.-]{1,128}$/
const safeSegment = (value: string) => segment.test(value) && value !== '.' && value !== '..'
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
// A record parser can silently omit __proto__. Check descriptors first, without running getters.
const stringsSchema = z.custom<Record<string, string>>((value: unknown) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128 || forbiddenKeys.has(key))
      return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    return (
      descriptor.enumerable &&
      'value' in descriptor &&
      typeof descriptor.value === 'string' &&
      descriptor.value.length <= 32_768
    )
  })
})
// KV v2 refuses any other custom metadata with HTTP 400, and kvCreateOnce writes it after the
// data. Lengths are UTF-8 bytes; the character classes are Go's unicode.IsPrint.
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u
const customMetadataSchema = stringsSchema.refine((value) => {
  const entries = Object.entries(value)
  return (
    entries.length <= 64 &&
    entries.every(
      ([key, text]) =>
        printable.test(key) &&
        printable.test(text) &&
        Buffer.byteLength(key, 'utf8') <= 128 &&
        Buffer.byteLength(text, 'utf8') <= 512,
    )
  )
})
const version = z.number().int().positive()
const isoDate = z.iso.datetime({ offset: true }).refine((date) => Number.isFinite(Date.parse(date)))
const versionMetadata = z.object({
  deletion_time: z.union([z.literal(''), isoDate]).default(''),
  destroyed: z.boolean().default(false),
})
const readSchema = z.object({
  data: z.object({
    data: stringsSchema.nullable(),
    metadata: versionMetadata.extend({ version }),
  }),
})
const writeSchema = z.object({ data: z.object({ version }) })
const metadataSchema = z.object({
  data: z.object({
    current_version: z.number().int().nonnegative(),
    created_time: isoDate,
    custom_metadata: stringsSchema.nullable().optional(),
    versions: z.record(z.string().regex(/^[1-9]\d*$/), versionMetadata),
  }),
})
const writeOptionsSchema = z.strictObject({ cas: z.number().int().nonnegative().optional() })
// Version 0 would mean the current one to KV v2: a reader that names a version names a real one.
const readOptionsSchema = z.strictObject({ version: version.max(2_147_483_647).optional() })
const listPageSchema = z.strictObject({
  after: z
    .string()
    .min(1)
    .max(129)
    .refine((key) => safeSegment(key.endsWith('/') ? key.slice(0, -1) : key))
    .optional(),
  limit: z.number().int().min(1).max(1000),
})
const listSchema = z.object({
  data: z.object({
    keys: z.array(
      z.string().refine((key) => safeSegment(key.endsWith('/') ? key.slice(0, -1) : key)),
    ),
  }),
})

/**
 * KV v2 over a shared authenticated session; permissions are enforced by Vault policies.
 * `onMount` receives the mount of every valid path before its request is sent.
 */
export function createKvStore(session: VaultSession, onMount?: (mount: string) => void): KvStore {
  const apiPath: typeof kvApiPath = (path, type, prefix) => {
    const url = kvApiPath(path, type, prefix)
    onMount?.(path.split('/', 1)[0]!)
    return url
  }

  async function read(path: string, options: { version?: number } = {}) {
    const url = apiPath(path, 'data')
    // Validated before any request: a version is never pasted into the URL unchecked.
    const parsed = readOptionsSchema.safeParse(options)
    if (!parsed.success) throw new VaultError('Invalid Vault KV read options')
    const wanted = parsed.data.version
    // KV v2 answers 404 for a version that is deleted, destroyed or was never written.
    const response = await session.request(
      wanted === undefined ? url : `${url}?version=${wanted}`,
      {
        method: 'GET',
        allowMissing: true,
        responseLimit: 'kv',
      },
    )
    if (response.status === 404) return null
    const result = readSchema.safeParse(response.json)
    if (!result.success) throw new VaultError('Unexpected Vault KV read response')
    const { data, metadata } = result.data.data
    if (metadata.destroyed || hasDeleted(metadata.deletion_time)) return null
    if (data === null) throw new VaultError('Unexpected empty Vault KV data')
    // A server that ignored the parameter would hand over another version than the one named.
    if (wanted !== undefined && metadata.version !== wanted)
      throw new VaultError('Unexpected Vault KV version')
    return { data, version: metadata.version }
  }

  async function write(
    path: string,
    data: Record<string, string>,
    options = {},
    forbiddenExpected = false,
  ) {
    const url = apiPath(path, 'data')
    const parsed = writeOptionsSchema.safeParse(options)
    if (!parsed.success) throw new VaultError('Invalid Vault KV write options')
    const body = {
      data: validateStrings(data),
      ...(parsed.data.cas === undefined ? {} : { options: { cas: parsed.data.cas } }),
    }
    validateBodySize(body)
    const response = await session.request(url, { method: 'POST', body, forbiddenExpected })
    const result = writeSchema.safeParse(response.json)
    if (!result.success) throw new VaultError('Unexpected Vault KV write response')
    return result.data.data
  }

  return {
    kvRead: read,
    kvWrite: write,
    async kvCreateOnce(path, data, metadata) {
      const metadataUrl = apiPath(path, 'metadata')
      // Validate both steps first. No invalid metadata may leave a newly written secret behind.
      const validatedData = validateStrings(data)
      const validatedMetadata = customMetadataSchema.safeParse(metadata)
      if (!validatedMetadata.success) throw new VaultError('Invalid Vault KV custom metadata')
      const body = { custom_metadata: { ...validatedMetadata.data } }
      validateBodySize(body)
      let state: 'created' | 'exists' = 'created'
      try {
        // A policy with create but no update answers 403 for a key that already exists.
        await write(path, validatedData, { cas: 0 }, true)
      } catch (error) {
        // A live value distinguishes a retry from denied access or a soft-deleted tombstone.
        // Never rewrite the data, even when a server/network failure leaves its outcome unknown.
        if (!(error instanceof VaultError) || ![400, 403].includes(error.status ?? 0)) throw error
        if ((await read(path)) === null) throw error
        state = 'exists'
      }
      // Data must precede metadata: precreating metadata would require update on the data path.
      // Repeating this second step repairs a crash between data and metadata writes.
      await session.request(metadataUrl, { method: 'POST', body })
      return state
    },
    async kvDelete(path) {
      await session.request(apiPath(path, 'data'), { method: 'DELETE' })
    },
    async kvDestroyAll(path) {
      await session.request(apiPath(path, 'metadata'), { method: 'DELETE' })
    },
    async kvList(prefix, page?: KvListPage) {
      const url = apiPath(prefix, 'metadata', true)
      const parsedPage = page === undefined ? undefined : listPageSchema.safeParse(page)
      if (parsedPage && !parsedPage.success) throw new VaultError('Invalid Vault KV list page')
      const response = await session.request(url, {
        method: 'LIST',
        allowMissing: true,
        responseLimit: 'list',
      })
      if (response.status === 404) return []
      const result = listSchema.safeParse(response.json)
      if (!result.success) throw new VaultError('Unexpected Vault KV list response')
      const keys = [...new Set(result.data.data.keys)].sort()
      if (!parsedPage) return keys
      const { after, limit } = parsedPage.data!
      return keys.filter((key) => after === undefined || key > after).slice(0, limit)
    },
    async kvMetadata(path): Promise<KvMetadata | null> {
      const response = await session.request(apiPath(path, 'metadata'), {
        method: 'GET',
        allowMissing: true,
        responseLimit: 'kv',
      })
      if (response.status === 404) return null
      const result = metadataSchema.safeParse(response.json)
      if (!result.success) throw new VaultError('Unexpected Vault KV metadata response')
      const data = result.data.data
      const current = data.versions[String(data.current_version)]
      if (!current && data.current_version !== 0)
        throw new VaultError('Unexpected Vault KV current version')
      return {
        currentVersion: data.current_version,
        custom: data.custom_metadata ?? {},
        createdTime: new Date(data.created_time),
        deleted: !current || current.destroyed || hasDeleted(current.deletion_time),
        destroyed: current?.destroyed ?? false,
      }
    },
  }
}

function kvApiPath(path: string, type: 'data' | 'metadata', prefix = false): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024)
    throw new VaultError('Invalid Vault KV path')
  const logical = prefix && path.endsWith('/') ? path.slice(0, -1) : path
  const [mount, ...parts] = logical.split('/')
  if (!mount || !safeSegment(mount) || (!prefix && parts.length === 0) || !parts.every(safeSegment))
    throw new VaultError('Invalid Vault KV path')
  return `/v1/${mount}/${type}${parts.length > 0 ? `/${parts.join('/')}` : ''}`
}

function validateStrings(value: Record<string, string>): Record<string, string> {
  const result = stringsSchema.safeParse(value)
  if (!result.success) throw new VaultError('Invalid Vault KV string data')
  return { ...result.data }
}

function validateBodySize(body: object): void {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > vaultHttpLimits.requestBytes)
    throw new VaultError('Vault request exceeds the size limit')
}

function hasDeleted(time: string): boolean {
  return time !== '' && Date.parse(time) <= Date.now()
}
