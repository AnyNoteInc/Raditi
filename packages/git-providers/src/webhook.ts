import type { GitProvider, GitWebhookEvent } from '@repo/domain'
import { normalizeGithubStyleEvent, normalizeGitlabEvent } from './webhook-events.ts'
import {
  verifyGiteaSignature,
  verifyGithubSignature,
  verifyGitlabToken,
} from './webhook-signature.ts'

type Verify = (headers: Headers, rawBody: string, secret: string) => boolean

/**
 * GitProvider.parseWebhook: the signature is checked on the raw body before anything else,
 * then the body is parsed and normalized. Every failure is null, never an exception, so a
 * public webhook endpoint cannot be made to throw by its input.
 */
function createWebhookParser(
  verify: Verify,
  eventHeader: string,
  normalize: (event: string, payload: unknown) => GitWebhookEvent | null,
): GitProvider['parseWebhook'] {
  return (headers, rawBody, secret) => {
    try {
      if (!verify(headers, rawBody, secret)) return null
      const event = headers.get(eventHeader)?.trim()
      if (!event) return null
      return normalize(event, JSON.parse(rawBody) as unknown)
    } catch {
      return null
    }
  }
}

export const parseGiteaWebhook = createWebhookParser(
  verifyGiteaSignature,
  'x-gitea-event',
  (event, payload) => normalizeGithubStyleEvent('gitea', event, payload),
)

export const parseGithubWebhook = createWebhookParser(
  verifyGithubSignature,
  'x-github-event',
  (event, payload) => normalizeGithubStyleEvent('github', event, payload),
)

export const parseGitlabWebhook = createWebhookParser(
  verifyGitlabToken,
  'x-gitlab-event',
  normalizeGitlabEvent,
)
