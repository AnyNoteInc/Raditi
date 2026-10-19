import { createHash } from 'node:crypto'

import {
  absentStateHashMaterial,
  badRequest,
  contentHashSchema,
  contentOperationRefSchema,
  contentRecoveryOutcomeSchema,
  contentTimeLeftSchema,
  contentWriteProofSchema,
  DomainError,
  publishedContentHashMaterial,
  publishedContentPatchSchema,
  publishedContentStateSchema,
  publishedObjectRefSchema,
  type ContentWriteRequest,
  type ContentOperationRequest,
  type PublishedContentGateway,
  SITE_CODE_REFRESH_PATHS,
  siteCodeCacheSchema,
  siteRuntimeSchema,
  siteCodeRefreshSchema,
  type SiteCodeCacheGateway,
  type SiteContentAdapter,
  type SiteContentConnection,
  type SiteHttpTransport,
  dbAbsentStateSchema,
  dbCreatedRecordSchema,
  dbObjectRefSchema,
  dbOperationRefSchema,
  dbOptionStateSchema,
  dbRecoveryOutcomeSchema,
  dbSlugSchema,
  dbTableStateSchema,
  dbWriteProofSchema,
  isOptionRef,
  isTableRef,
  legacySiteDbCapabilities,
  optionNameOf,
  optionStateHashMaterial,
  siteDbCapabilitiesSchema,
  tableDefinitionSchema,
  tableNameOf,
  tableStateHashMaterial,
  type DbObjectState,
  type DbOperationRequest,
  type DbRecoveryOutcome,
  type DbWriteOutcome,
  type DbWriteProof,
  type DbWriteRequest,
  type SiteDbGateway,
} from '@repo/domain'
import { z } from 'zod'

import { fetchSiteTransport } from './http-transport.ts'

const unavailable = () =>
  new DomainError('CONTENT_GATEWAY_UNAVAILABLE', 'Published content gateway is unavailable', 502)
const tooLarge = () =>
  new DomainError('CONTENT_TOO_LARGE', 'Published content exceeds its size limit', 413)
const objectUnavailable = () =>
  new DomainError('CONTENT_OBJECT_UNAVAILABLE', 'Published content object is not available', 404)
const rejected = z.strictObject({
  version: z.literal(1),
  kind: z.literal('rejected'),
  code: z.enum(['conflict', 'fenced', 'invalid', 'unavailable']),
  /**
   * Why a value is invalid for this site: its filter would alter the markup, the state would
   * exceed the limit, or its database would store other text.
   */
  reason: z.enum(['markup', 'size', 'storage']).optional(),
})
/** A refusal of a write of an object of a plan: the reasons of published content and more. */
const dbRejected = rejected.extend({
  /**
   * `slug` — the address is taken or not one of an address; `unsupported` — not here;
   * `dependents` — a record the trash would take more of the site along with (a conflict).
   */
  reason: z.enum(['markup', 'size', 'storage', 'slug', 'unsupported', 'dependents']).optional(),
})
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const dbEnvelopeSchema = z.strictObject({
  callId: z.uuid(),
  siteId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  requestHash: contentHashSchema,
  objectRef: dbObjectRefSchema,
  expectedStateHash: contentHashSchema,
  deadlineAt: z.number().int().safe().positive(),
  ttlMs: contentTimeLeftSchema,
  mode: z.enum(['edit', 'restore', 'release']),
})
const tableBodySchema = z.strictObject({
  exists: z.boolean(),
  managed: z.boolean(),
  definition: tableDefinitionSchema.nullable(),
})
const dbChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('option_update'),
    value: z
      .string()
      .max(32768)
      .refine((value) => !value.includes('\0'))
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('post_create'),
    record: dbCreatedRecordSchema,
    createCallId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('post_trash'),
    expectedSlug: z.string().min(1).max(200),
    createCallId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('post_untrash'),
    expectedSlug: z.string().min(1).max(200),
    createCallId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('schema_migration'),
    before: tableBodySchema,
    definition: tableDefinitionSchema.nullable(),
  }),
])
const recordRefSchema = publishedObjectRefSchema
/**
 * A 32 KiB state is up to 96 KiB on the wire: WordPress sends every non-ASCII character as
 * \uXXXX escapes, six bytes for a two-byte Cyrillic letter.
 */
const RESPONSE_MAX_BYTES = 128 * 1024
const REQUEST_TIMEOUT_MS = 10_000
/**
 * The platform owns the deadline. The site gets what is left of it as a duration and measures
 * that on its own clock: a customer server's clock is never compared with the platform's. The
 * duration comes with the request, from the clock that set the deadline, not from this process.
 */
const requestSchema = z.strictObject({
  callId: z.uuid(),
  siteId: z.uuid(),
  epoch: z.number().int().positive(),
  requestHash: contentHashSchema,
  objectRef: publishedObjectRefSchema,
  expectedStateHash: contentHashSchema,
  deadlineAt: z.number().int().safe().positive(),
  ttlMs: contentTimeLeftSchema,
  mode: z.enum(['edit', 'restore', 'release']),
  fields: publishedContentPatchSchema,
})
const operationSchema = contentOperationRefSchema.extend({ ttlMs: contentTimeLeftSchema })
export interface WordpressContentConnection {
  origin: string
  siteId: string
  username: string
  applicationPassword: string
  /** Disposable local fixtures only. Customer sites require HTTPS. */
  allowLoopbackHttp?: boolean
}

/**
 * A path a refresh of the code cache names: relative to the root of the site, no `.` or `..`
 * segment, no empty one, no backslash or NUL.
 */
const codePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/[\\\0]/.test(path) &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  )

/** Fixed routes to the Raditi companion plugin. No generic wp_rest or wp_cli escape hatch. */
export class WordpressPublishedContentGateway
  implements PublishedContentGateway, SiteCodeCacheGateway
{
  readonly #origin: URL
  readonly #authorization: string
  readonly #siteId: string
  readonly #transport: SiteHttpTransport
  /** The objects of a database plan through the same plugin (version 2). */
  readonly db: SiteDbGateway = {
    capabilities: () => this.#capabilities(),
    readObject: (objectRef) => this.#readObject(objectRef),
    slugTaken: (type, slug) => this.#slugTaken(type, slug),
    dependents: (objectRef) => this.#dependents(objectRef),
    writeObject: (request) => this.#writeObject(request),
    operation: (callId) => this.#dbOperation(callId),
    reconcile: (request) => this.#dbReconcile(request),
    fence: (input) => this.#fence(input),
  }
  /**
   * `transport` carries every request to the site. The default is the plain one of this
   * package; the role that reaches customer sites passes its own.
   */
  constructor(
    connection: WordpressContentConnection,
    transport: SiteHttpTransport = fetchSiteTransport,
  ) {
    this.#transport = transport
    try {
      const origin = new URL(connection.origin)
      if (
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== '/' ||
        (origin.protocol !== 'https:' &&
          !(
            connection.allowLoopbackHttp &&
            origin.protocol === 'http:' &&
            ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
          )) ||
        !z.uuid().safeParse(connection.siteId).success ||
        !connection.username ||
        /[:\r\n]/.test(connection.username) ||
        !connection.applicationPassword ||
        /[\r\n]/.test(connection.applicationPassword)
      )
        throw unavailable()
      this.#origin = origin
      this.#siteId = connection.siteId
      this.#authorization = `Basic ${Buffer.from(`${connection.username}:${connection.applicationPassword}`).toString('base64')}`
    } catch {
      throw unavailable()
    }
  }

  async read(objectRef: string) {
    const ref = publishedObjectRefSchema.safeParse(objectRef)
    if (!ref.success) throw badRequest('Unsupported published content object')
    const raw = await this.#request(`/raditi/v1/content/${ref.data.split(':')[1]}`)
    const denied = rejected.safeParse(raw)
    if (denied.success) {
      if (denied.data.reason === 'size') throw tooLarge()
      // Missing, not published, protected by a password or not editable by this connection.
      throw denied.data.code === 'invalid' ? objectUnavailable() : unavailable()
    }
    const result = publishedContentStateSchema.safeParse(raw)
    if (
      !result.success ||
      result.data.objectRef !== ref.data ||
      result.data.kind !== ref.data.split(':')[0] ||
      createHash('sha256').update(publishedContentHashMaterial(result.data)).digest('hex') !==
        result.data.stateHash
    )
      throw unavailable()
    return result.data
  }

  async conditionalWrite(input: ContentWriteRequest) {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success || parsed.data.siteId !== this.#siteId)
      throw badRequest('Invalid published content write')
    const request = parsed.data
    const raw = await this.#request(
      `/raditi/v1/content/${request.objectRef.split(':')[1]}`,
      request,
    )
    const denied = rejected.safeParse(raw)
    if (denied.success) return denied.data
    const proof = contentWriteProofSchema.safeParse(raw)
    if (
      !proof.success ||
      proof.data.callId !== request.callId ||
      proof.data.siteId !== request.siteId ||
      proof.data.epoch !== request.epoch ||
      proof.data.requestHash !== request.requestHash ||
      proof.data.objectRef !== request.objectRef
    )
      throw unavailable()
    return proof.data
  }

  async operation(callId: string) {
    if (!z.uuid().safeParse(callId).success) throw badRequest('Invalid content operation reference')
    const raw = await this.#request(`/raditi/v1/operations/${callId}`)
    if (
      raw === null ||
      z.strictObject({ version: z.literal(1), kind: z.literal('unknown') }).safeParse(raw).success
    )
      return null
    const proof = contentWriteProofSchema.safeParse(raw)
    if (!proof.success || proof.data.callId !== callId || proof.data.siteId !== this.#siteId)
      throw unavailable()
    return proof.data
  }

  async reconcileOperation(input: ContentOperationRequest) {
    const request = this.#operation(input)
    const outcome = contentRecoveryOutcomeSchema.safeParse(
      await this.#request(`/raditi/v1/operations/${request.callId}/reconcile`, request),
    )
    if (!outcome.success) throw unavailable()
    const proof = outcome.data
    if (
      proof.kind !== 'unknown' &&
      (proof.callId !== request.callId ||
        proof.siteId !== request.siteId ||
        proof.epoch !== request.epoch ||
        proof.requestHash !== request.requestHash ||
        proof.objectRef !== request.objectRef ||
        (proof.kind === 'not_committed' && proof.deadlineAt !== request.deadlineAt))
    )
      throw unavailable()
    return proof
  }

  async forgetOperation(input: ContentOperationRequest): Promise<void> {
    const request = this.#operation(input)
    const result = z
      .strictObject({ version: z.literal(1), kind: z.literal('forgotten'), callId: z.uuid() })
      .safeParse(await this.#request(`/raditi/v1/operations/${request.callId}/forget`, request))
    if (!result.success || result.data.callId !== request.callId) throw unavailable()
  }

  /** `GET /raditi/v1/runtime`: the version of the site's PHP and its loaded extensions. */
  async runtime() {
    const runtime = siteRuntimeSchema.safeParse(await this.#request('/raditi/v1/runtime'))
    if (!runtime.success) throw unavailable()
    return runtime.data
  }

  /** `GET /raditi/v1/code-cache`: the opcache of the site's PHP as the plugin reads it (R12). */
  async codeCache() {
    const state = siteCodeCacheSchema.safeParse(await this.#request('/raditi/v1/code-cache'))
    if (!state.success) throw unavailable()
    return state.data
  }

  /** `POST /raditi/v1/code-cache`: drops these files from the opcache of the site's PHP. */
  async refreshCode(paths: readonly string[]) {
    const list = z.array(codePathSchema).min(1).max(SITE_CODE_REFRESH_PATHS).safeParse(paths)
    if (!list.success) throw badRequest('Invalid paths of a code cache refresh')
    const result = siteCodeRefreshSchema.safeParse(
      await this.#request('/raditi/v1/code-cache', { version: 1, paths: list.data }),
    )
    if (
      !result.success ||
      result.data.refreshed + result.data.absent + result.data.failed !== list.data.length
    )
      throw unavailable()
    return result.data
  }

  /** `GET /raditi/v1/capabilities`; a plugin before version 2 has no such route. */
  async #capabilities() {
    const raw = await this.#request('/raditi/v1/capabilities', undefined, true)
    if (raw === null) return { ...legacySiteDbCapabilities }
    const parsed = siteDbCapabilitiesSchema.safeParse(raw)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }

  /**
   * The state of an object of a plan, its hash checked against its own fields: a record (or its
   * absence), a setting of the list, a table of the platform.
   */
  async #readObject(objectRef: string): Promise<DbObjectState> {
    const ref = dbObjectRefSchema.safeParse(objectRef)
    if (!ref.success) throw badRequest('Unsupported database plan object')
    const route = isOptionRef(objectRef)
      ? `/raditi/v1/settings/${optionNameOf(objectRef)}`
      : isTableRef(objectRef)
        ? `/raditi/v1/tables/${tableNameOf(objectRef)}`
        : recordRefSchema.safeParse(objectRef).success
          ? `/raditi/v1/records/${objectRef.replace(':', '/')}`
          : null
    if (route === null) throw badRequest('Unsupported database plan object')
    const raw = await this.#request(route)
    const denied = rejected.safeParse(raw)
    if (denied.success) {
      if (denied.data.reason === 'size') throw tooLarge()
      throw denied.data.code === 'invalid' ? objectUnavailable() : unavailable()
    }
    const state = (() => {
      if (isOptionRef(objectRef)) {
        const option = dbOptionStateSchema.safeParse(raw)
        return option.success &&
          sha256(optionStateHashMaterial(option.data)) === option.data.stateHash
          ? option.data
          : null
      }
      if (isTableRef(objectRef)) {
        const table = dbTableStateSchema.safeParse(raw)
        return table.success && sha256(tableStateHashMaterial(table.data)) === table.data.stateHash
          ? table.data
          : null
      }
      const absent = dbAbsentStateSchema.safeParse(raw)
      if (absent.success)
        return sha256(absentStateHashMaterial(absent.data.objectRef)) === absent.data.stateHash
          ? absent.data
          : null
      const record = publishedContentStateSchema.safeParse(raw)
      return record.success &&
        record.data.kind === objectRef.split(':')[0] &&
        sha256(publishedContentHashMaterial(record.data)) === record.data.stateHash
        ? record.data
        : null
    })()
    if (!state || state.objectRef !== objectRef) throw unavailable()
    return state
  }

  /** `GET /raditi/v1/slugs/<type>/<slug>`: whether a record at this address would collide. */
  async #slugTaken(type: string, slug: string) {
    if (!['post', 'page'].includes(type) || !dbSlugSchema.safeParse(slug).success)
      throw badRequest('Invalid address of a record')
    const answer = z
      .strictObject({ version: z.literal(1), kind: z.literal('slug'), taken: z.boolean() })
      .safeParse(await this.#request(`/raditi/v1/slugs/${type}/${slug}`))
    if (!answer.success) throw unavailable()
    return answer.data.taken
  }

  /**
   * `GET /raditi/v1/records/<type>/<id>/dependents`: how many records of the site stand on this
   * one — its comments of any status, records below it, menu items that open it.
   */
  async #dependents(objectRef: string): Promise<number> {
    const ref = recordRefSchema.safeParse(objectRef)
    if (!ref.success) throw badRequest('Unsupported record')
    const raw = await this.#request(`/raditi/v1/records/${ref.data.replace(':', '/')}/dependents`)
    const denied = rejected.safeParse(raw)
    if (denied.success) throw denied.data.code === 'invalid' ? objectUnavailable() : unavailable()
    const answer = z
      .strictObject({
        version: z.literal(1),
        kind: z.literal('dependents'),
        objectRef: z.literal(ref.data),
        count: z.number().int().min(0).max(1_000_000_000),
      })
      .safeParse(raw)
    if (!answer.success) throw unavailable()
    return answer.data.count
  }

  /**
   * One write of an object of a plan: a setting, a creation, the trash of a created record, a
   * table. A receipt is taken only for this call, site, epoch, request and object; a creation's
   * names the record it made, nothing else does.
   */
  async #writeObject(input: DbWriteRequest): Promise<DbWriteOutcome> {
    const { change, ...rest } = input
    const envelope = dbEnvelopeSchema.safeParse(rest)
    const parsed = dbChangeSchema.safeParse(change)
    if (!envelope.success || !parsed.success || envelope.data.siteId !== this.#siteId)
      throw badRequest('Invalid database plan write')
    const request = envelope.data
    const ref = request.objectRef
    const { kind, ...own } = parsed.data
    const route =
      kind === 'option_update' && isOptionRef(ref)
        ? `/raditi/v1/settings/${optionNameOf(ref)}`
        : kind === 'schema_migration' && isTableRef(ref)
          ? `/raditi/v1/tables/${tableNameOf(ref)}`
          : kind === 'post_create' && recordRefSchema.safeParse(ref).success
            ? `/raditi/v1/records/${ref.split(':')[0]}`
            : (kind === 'post_trash' || kind === 'post_untrash') &&
                recordRefSchema.safeParse(ref).success
              ? `/raditi/v1/records/${ref.replace(':', '/')}/${kind === 'post_trash' ? 'trash' : 'untrash'}`
              : null
    if (route === null) throw badRequest('Invalid database plan write')
    const raw = await this.#request(route, { ...request, ...own })
    const denied = dbRejected.safeParse(raw)
    if (denied.success) return denied.data as DbWriteOutcome
    const proof = dbWriteProofSchema.safeParse(raw)
    if (
      !proof.success ||
      proof.data.callId !== request.callId ||
      proof.data.siteId !== request.siteId ||
      proof.data.epoch !== request.epoch ||
      proof.data.requestHash !== request.requestHash ||
      proof.data.objectRef !== ref ||
      (kind === 'post_create') !== (proof.data.createdRef !== undefined) ||
      (proof.data.createdRef !== undefined &&
        proof.data.createdRef.split(':')[0] !== ref.split(':')[0])
    )
      throw unavailable()
    return proof.data
  }

  /**
   * `GET /raditi/v1/operations/<call>` of a write of an object of a plan: its receipt — a
   * creation's names the record production made —, or null when the plugin keeps none.
   */
  async #dbOperation(callId: string): Promise<DbWriteProof | null> {
    if (!z.uuid().safeParse(callId).success) throw badRequest('Invalid content operation reference')
    const raw = await this.#request(`/raditi/v1/operations/${callId}`)
    if (
      raw === null ||
      z.strictObject({ version: z.literal(1), kind: z.literal('unknown') }).safeParse(raw).success
    )
      return null
    const proof = dbWriteProofSchema.safeParse(raw)
    if (!proof.success || proof.data.callId !== callId || proof.data.siteId !== this.#siteId)
      throw unavailable()
    return proof.data
  }

  /** `POST /raditi/v1/operations/<call>/reconcile` of a write of an object of a plan. */
  async #dbReconcile(input: DbOperationRequest): Promise<DbRecoveryOutcome> {
    const parsed = dbOperationRefSchema.safeParse(input)
    if (!parsed.success || parsed.data.siteId !== this.#siteId)
      throw badRequest('Invalid content operation reference')
    const request = parsed.data
    const outcome = dbRecoveryOutcomeSchema.safeParse(
      await this.#request(`/raditi/v1/operations/${request.callId}/reconcile`, request),
    )
    if (!outcome.success) throw unavailable()
    const proof = outcome.data
    if (
      proof.kind !== 'unknown' &&
      (proof.callId !== request.callId ||
        proof.siteId !== request.siteId ||
        proof.epoch !== request.epoch ||
        proof.requestHash !== request.requestHash ||
        proof.objectRef !== request.objectRef ||
        (proof.kind === 'not_committed' && proof.deadlineAt !== request.deadlineAt))
    )
      throw unavailable()
    return proof
  }

  /** `POST /raditi/v1/fence`: the fence of the plugin moved to `epoch`, nothing else written. */
  async #fence(input: { siteId: string; epoch: number }) {
    const parsed = z
      .strictObject({ siteId: z.uuid(), epoch: z.number().int().positive().max(2147483647) })
      .safeParse(input)
    if (!parsed.success || parsed.data.siteId !== this.#siteId) throw badRequest('Invalid fence')
    const answer = z
      .strictObject({
        version: z.literal(1),
        kind: z.literal('fenced'),
        epoch: z.number().int().positive(),
      })
      .safeParse(await this.#request('/raditi/v1/fence', parsed.data))
    if (!answer.success || answer.data.epoch < parsed.data.epoch) throw unavailable()
  }

  #operation(input: ContentOperationRequest) {
    const parsed = operationSchema.safeParse(input)
    if (!parsed.success || parsed.data.siteId !== this.#siteId)
      throw badRequest('Invalid content operation reference')
    return parsed.data
  }

  /** `absentOn404` — a route a plugin of an earlier version does not have answers null. */
  async #request(route: string, body?: unknown, absentOn404 = false): Promise<unknown> {
    const url = new URL(this.#origin)
    url.searchParams.set('rest_route', route)
    try {
      const response = await this.#transport({
        url: url.href,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: this.#authorization,
          'content-type': 'application/json',
          'x-raditi-site': this.#siteId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: RESPONSE_MAX_BYTES,
      })
      // The limits are checked here as well: a transport is trusted with neither.
      if (response.body.byteLength > RESPONSE_MAX_BYTES) throw unavailable()
      if (absentOn404 && response.status === 404) {
        const missing = z
          .object({ code: z.literal('rest_no_route') })
          .safeParse(JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown)
        if (missing.success) return null
      }
      if (response.status !== 200) throw unavailable()
      return JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown
    } catch {
      throw unavailable()
    }
  }
}

const oneLine = (value: string) => !/[\r\n]/.test(value)
/**
 * The `wp` access of a site as Vault keeps it under `kv/sites/<siteId>/wp`: the origin the
 * application password was issued for, the WordPress user and the password. Strings only (KV).
 */
export const wordpressContentAccessSchema = z.strictObject({
  v: z.literal('1'),
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && url.origin === value
      } catch {
        return false
      }
    }),
  username: z
    .string()
    .min(1)
    .max(60)
    .refine((value) => oneLine(value) && !value.includes(':')),
  applicationPassword: z.string().min(1).max(255).refine(oneLine),
})
export type WordpressContentAccess = z.infer<typeof wordpressContentAccessSchema>

function wordpressGatewayOf({
  siteId,
  origin,
  access,
  transport,
  allowLoopbackHttp,
}: SiteContentConnection<WordpressContentAccess>): WordpressPublishedContentGateway {
  return new WordpressPublishedContentGateway(
    {
      origin,
      siteId,
      username: access.username,
      applicationPassword: access.applicationPassword,
      allowLoopbackHttp,
    },
    transport,
  )
}

/**
 * Published content of WordPress: the `wp` access, the gateway to the companion plugin and,
 * through the same plugin, the code cache of the site's PHP.
 */
export const wordpressContentAdapter: SiteContentAdapter<WordpressContentAccess> = {
  stack: 'wordpress',
  accessKind: 'wp',
  accessSchema: wordpressContentAccessSchema,
  createGateway: (connection) => wordpressGatewayOf(connection),
  createCodeCache: (connection) => wordpressGatewayOf(connection),
}
