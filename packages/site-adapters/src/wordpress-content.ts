import { createHash } from 'node:crypto'

import {
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
  type SiteContentAdapter,
  type SiteHttpTransport,
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
  mode: z.enum(['edit', 'restore']),
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

/** Fixed routes to the Raditi companion plugin. No generic wp_rest or wp_cli escape hatch. */
export class WordpressPublishedContentGateway implements PublishedContentGateway {
  readonly #origin: URL
  readonly #authorization: string
  readonly #siteId: string
  readonly #transport: SiteHttpTransport
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

  #operation(input: ContentOperationRequest) {
    const parsed = operationSchema.safeParse(input)
    if (!parsed.success || parsed.data.siteId !== this.#siteId)
      throw badRequest('Invalid content operation reference')
    return parsed.data
  }

  async #request(route: string, body?: unknown): Promise<unknown> {
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
      if (response.status !== 200 || response.body.byteLength > RESPONSE_MAX_BYTES)
        throw unavailable()
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

/** Published content of WordPress: the `wp` access and the gateway to the companion plugin. */
export const wordpressContentAdapter: SiteContentAdapter<WordpressContentAccess> = {
  stack: 'wordpress',
  accessKind: 'wp',
  accessSchema: wordpressContentAccessSchema,
  createGateway: ({ siteId, origin, access, transport, allowLoopbackHttp }) =>
    new WordpressPublishedContentGateway(
      {
        origin,
        siteId,
        username: access.username,
        applicationPassword: access.applicationPassword,
        allowLoopbackHttp,
      },
      transport,
    ),
}
