import { z } from 'zod'

import { isProduction, type AppEnv } from '../app-env.ts'
import type { ArtifactGrantRole } from './roles.ts'

// Access of other users to an artifact (docs/plan/88-artifacts.md, Ар33–Ар36, §7.8; slice 88.16):
// a link for those who signed in, or an invitation; the roles «Смотрит» and «Правит» first,
// «Комментирует» with the comments between people (Э10а).

/**
 * Whether other users may be given access in production. On since the edition of the four documents
 * of 2026-11-23 and the storage of an organiser of distribution of information — the facts with the
 * port of the edge — stand in production (Э9, slice 88.16а, Ар56; release v1.77.0 and the check of
 * `ori_fact_ports` on the server). Turning it off closes every new link and invitation again.
 */
export const artifactSharingInProduction = true

export function artifactSharingOpen(appEnv: AppEnv): boolean {
  return !isProduction(appEnv) || artifactSharingInProduction
}

/** The roles a link or an invitation gives (Ар36): «Комментирует» with the threads of Э10а. */
export const artifactOpenGrantRoles = [
  'view',
  'comment',
  'edit',
] as const satisfies readonly ArtifactGrantRole[]
export type ArtifactOpenGrantRole = (typeof artifactOpenGrantRoles)[number]

/** How long a link lives (Ар33): no term by default, or 7 or 30 days. */
export const artifactLinkTerms = [null, 7, 30] as const
export type ArtifactLinkTerm = (typeof artifactLinkTerms)[number]

/** A token of a link: 32 random bytes, base64url — 43 characters, in the fragment of `/a#…`. */
export const artifactLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** The address of a link: only `https://<cabinet>/a#<token>` (Ар33, spike 8). */
export const artifactLinkUrl = (cabinetOrigin: string, token: string): string =>
  `${cabinetOrigin.replace(/\/$/, '')}/a#${token}`

/** How long an invitation waits, and its address is kept (Ар35, §7.1). */
export const artifactInviteDays = 30
/** At most this many invitations a user sends a day, and an artifact gets a day (Ар35). */
export const artifactInviteLimits = { perUserDay: 50, perArtifactDay: 10 } as const

/** The kind of an artifact as the letter of an invitation says it — no title (Ар35). */
export function artifactInviteKindWord(
  kind: string,
): 'документ' | 'холст' | 'презентацию' | 'изображение' | 'артефакт' {
  switch (kind) {
    case 'document':
      return 'документ'
    case 'canvas':
      return 'холст'
    case 'slides':
      return 'презентацию'
    case 'image':
      return 'изображение'
    default:
      return 'артефакт'
  }
}

export const artifactInviteEmailSchema = z
  .email()
  .max(320)
  .transform((email) => email.toLowerCase())
