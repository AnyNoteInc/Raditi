import { z } from 'zod'

import { isProduction, type AppEnv } from '../app-env.ts'
import type { ArtifactGrantRole } from './roles.ts'

// Access of other users to an artifact (docs/plan/88-artifacts.md, Ар33–Ар36, §7.8; slice 88.16):
// a link for those who signed in, or an invitation; the roles «Смотрит» and «Правит» first,
// «Комментирует» with the comments between people (Э10а).

/**
 * Whether other users may be given access in production. Off until the new edition of the four
 * documents is published and the storage of an organiser of distribution of information stands
 * (Э9, slice 88.16а, Ар56). Outside production it works, for the stands and the tests.
 */
export const artifactSharingInProduction = false

export function artifactSharingOpen(appEnv: AppEnv): boolean {
  return !isProduction(appEnv) || artifactSharingInProduction
}

/** The roles a link or an invitation gives now (Ар36): «Комментирует» comes with Э10а. */
export const artifactOpenGrantRoles = ['view', 'edit'] as const satisfies readonly ArtifactGrantRole[]
export type ArtifactOpenGrantRole = (typeof artifactOpenGrantRoles)[number]

/** How long a link lives (Ар33): no term by default, or 7 or 30 days. */
export const artifactLinkTerms = [null, 7, 30] as const
export type ArtifactLinkTerm = (typeof artifactLinkTerms)[number]

/** A token of a link: 32 random bytes, base64url — 43 characters, in the fragment of `/a#…`. */
export const artifactLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** The address of a link: only `https://<cabinet>/a#<token>` (Ар33, spike 8). */
export const artifactLinkUrl = (cabinetOrigin: string, token: string): string =>
  `${cabinetOrigin.replace(/\/$/, '')}/a#${token}`
