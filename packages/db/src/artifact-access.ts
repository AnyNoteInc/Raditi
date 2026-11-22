import { createHash, randomBytes } from 'node:crypto'

import {
  artifactGrantAllowed,
  artifactGrantRefused,
  artifactKindSpecOf,
  artifactLinkGone,
  artifactNotFound,
  artifactOpenGrantRoles,
  artifactRoleCan,
  strongestArtifactRole,
  type ArtifactGrantRole,
  type ArtifactKind,
  type ArtifactLinkTerm,
  type ArtifactOpenGrantRole,
  type ArtifactRole,
} from '@repo/domain/artifacts'

import { artifactRole, lockArtifact } from './artifacts.ts'
import type { Prisma, PrismaClient } from './generated/prisma/client.ts'

// Access of other users to an artifact (docs/plan/88-artifacts.md, Ар33–Ар36, §7.8; slice
// 88.16-1). Only the owner shares and changes access; a recipient opens by a link and leaves. A
// grant is per source (Ар34): revoking a link takes only its grants away; «Закрыть доступ всем»
// revokes the links and deletes every grant. Whether sharing is open is the caller's (the flag).

type Tx = Prisma.TransactionClient
type Db = Pick<PrismaClient, '$transaction'>
const DAY_MS = 24 * 60 * 60 * 1000

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

/** The owner's artifact under its lock, live; the access refusal is «not found» (Ар23). */
async function lockShared(tx: Tx, input: { artifactId: string; userId: string }) {
  const artifact = await lockArtifact(tx, input.artifactId)
  const role = await artifactRole(tx, input)
  if (!artifactRoleCan(role, 'share') || artifact.deletedAt !== null) throw artifactNotFound()
  return artifact
}

function requireGrantable(kind: string, role: ArtifactGrantRole) {
  const spec = artifactKindSpecOf(kind)
  if (
    !spec ||
    !(artifactOpenGrantRoles as readonly string[]).includes(role) ||
    !artifactGrantAllowed(kind as ArtifactKind, role)
  )
    throw artifactGrantRefused()
}

/**
 * «Новая ссылка» (Ар33): a token of 32 random bytes, only its SHA-256 kept; the link before is
 * revoked, and its grants with it. The token is returned once: the cabinet makes `/a#<token>`.
 */
export async function createArtifactLink(
  db: Db,
  input: {
    artifactId: string
    userId: string
    role: ArtifactOpenGrantRole
    term: ArtifactLinkTerm
    now: Date
  },
): Promise<{ token: string; linkId: string; expiresAt: Date | null }> {
  return db.$transaction(async (tx) => {
    const artifact = await lockShared(tx, input)
    requireGrantable(artifact.kind, input.role)
    await tx.artifactLink.updateMany({
      where: { artifactId: artifact.id, revokedAt: null },
      data: { revokedAt: input.now },
    })
    const token = randomBytes(32).toString('base64url')
    const expiresAt =
      input.term === null ? null : new Date(input.now.getTime() + input.term * DAY_MS)
    const link = await tx.artifactLink.create({
      data: {
        artifactId: artifact.id,
        tokenHash: hashOf(token),
        role: input.role,
        createdBy: input.userId,
        createdAt: input.now,
        expiresAt,
      },
      select: { id: true },
    })
    return { token, linkId: link.id, expiresAt }
  })
}

/** «Отключить ссылку»: those who came by it lose what it gave them. */
export async function revokeArtifactLink(
  db: Db,
  input: { artifactId: string; userId: string; now: Date },
): Promise<{ revoked: boolean }> {
  return db.$transaction(async (tx) => {
    await lockShared(tx, input)
    const { count } = await tx.artifactLink.updateMany({
      where: { artifactId: input.artifactId, revokedAt: null },
      data: { revokedAt: input.now },
    })
    return { revoked: count > 0 }
  })
}

/**
 * «Открыть» by a token after sign-in and consent (Ар33): the owner just opens it; another user gets
 * a grant of the link's role. A link revoked, expired, of an artifact gone or taken down — gone.
 */
export async function openArtifactLink(
  db: Db,
  input: { token: string; userId: string; now: Date },
): Promise<{ artifactId: string; role: ArtifactRole }> {
  return db.$transaction(async (tx) => {
    const link = await tx.artifactLink.findUnique({
      where: { tokenHash: hashOf(input.token) },
      select: { id: true, artifactId: true, role: true, revokedAt: true, expiresAt: true },
    })
    if (
      !link ||
      link.revokedAt !== null ||
      (link.expiresAt !== null && link.expiresAt <= input.now)
    )
      throw artifactLinkGone()
    const artifact = await lockArtifact(tx, link.artifactId)
    if (artifact.deletedAt !== null || artifact.takenDownAt !== null) throw artifactLinkGone()
    const before = await artifactRole(tx, { artifactId: link.artifactId, userId: input.userId })
    if (before === 'owner') return { artifactId: link.artifactId, role: before }
    const owner = await artifactRole(tx, {
      artifactId: link.artifactId,
      userId: artifact.ownerUserId ?? '00000000-0000-0000-0000-000000000000',
    })
    // An artifact without a living owner opens to nobody.
    if (owner !== 'owner') throw artifactLinkGone()
    // Under the lock of the artifact: one grant of this link for this user.
    const granted = await tx.artifactGrant.findFirst({
      where: { artifactId: link.artifactId, userId: input.userId, source: 'link', linkId: link.id },
      select: { id: true },
    })
    if (!granted)
      await tx.artifactGrant.create({
        data: {
          artifactId: link.artifactId,
          userId: input.userId,
          source: 'link',
          linkId: link.id,
          role: link.role,
          grantedBy: artifact.ownerUserId,
        },
      })
    await tx.artifactLink.update({
      where: { id: link.id },
      data: { opens: { increment: 1 }, lastOpenedAt: input.now },
    })
    const role = await artifactRole(tx, { artifactId: link.artifactId, userId: input.userId })
    if (role === null) throw artifactLinkGone()
    return { artifactId: link.artifactId, role }
  })
}

export interface ArtifactAccessState {
  link: { role: string; createdAt: Date; expiresAt: Date | null; opens: number } | null
  people: {
    userId: string
    name: string
    email: string
    role: ArtifactRole
    sources: ('invite' | 'link')[]
  }[]
}

/** «Поделиться» (Ар35): the live link and everyone with a live grant — only the owner reads it. */
export async function artifactAccessState(
  db: Db,
  input: { artifactId: string; userId: string; now: Date },
): Promise<ArtifactAccessState> {
  return db.$transaction(
    async (tx) => {
      const role = await artifactRole(tx, input)
      if (!artifactRoleCan(role, 'share')) throw artifactNotFound()
      const link = await tx.artifactLink.findFirst({
        where: { artifactId: input.artifactId, revokedAt: null },
        select: { id: true, role: true, createdAt: true, expiresAt: true, opens: true },
      })
      const liveLink = link && (link.expiresAt === null || link.expiresAt > input.now) ? link : null
      const grants = await tx.artifactGrant.findMany({
        where: {
          artifactId: input.artifactId,
          OR: [{ source: 'invite' }, ...(liveLink ? [{ linkId: liveLink.id }] : [])],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true,
          role: true,
          source: true,
          user: { select: { name: true, email: true } },
        },
      })
      const people = new Map<string, ArtifactAccessState['people'][number]>()
      for (const grant of grants) {
        const known = people.get(grant.userId)
        const role = strongestArtifactRole([known?.role, grant.role as ArtifactRole])!
        people.set(grant.userId, {
          userId: grant.userId,
          name: grant.user.name,
          email: grant.user.email,
          role,
          sources: [...new Set([...(known?.sources ?? []), grant.source as 'invite' | 'link'])],
        })
      }
      return {
        link: liveLink
          ? {
              role: liveLink.role,
              createdAt: liveLink.createdAt,
              expiresAt: liveLink.expiresAt,
              opens: liveLink.opens,
            }
          : null,
        people: [...people.values()],
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

/** «Смотрит» / «Правит» of one recipient: every grant of theirs gets the role. */
export async function setArtifactRecipientRole(
  db: Db,
  input: { artifactId: string; userId: string; recipientId: string; role: ArtifactOpenGrantRole },
): Promise<{ changed: number }> {
  return db.$transaction(async (tx) => {
    const artifact = await lockShared(tx, input)
    requireGrantable(artifact.kind, input.role)
    const { count } = await tx.artifactGrant.updateMany({
      where: { artifactId: input.artifactId, userId: input.recipientId },
      data: { role: input.role },
    })
    return { changed: count }
  })
}

/** «Убрать доступ» of one recipient: all their grants go, by any source. */
export async function removeArtifactRecipient(
  db: Db,
  input: { artifactId: string; userId: string; recipientId: string },
): Promise<{ removed: number }> {
  return db.$transaction(async (tx) => {
    await lockShared(tx, input)
    const { count } = await tx.artifactGrant.deleteMany({
      where: { artifactId: input.artifactId, userId: input.recipientId },
    })
    return { removed: count }
  })
}

/** «Закрыть доступ всем» (Ар34): in one transaction the links are revoked and every grant goes. */
export async function closeArtifactAccess(
  db: Db,
  input: { artifactId: string; userId: string; now: Date },
): Promise<{ links: number; grants: number }> {
  return db.$transaction(async (tx) => {
    await lockShared(tx, input)
    const links = await tx.artifactLink.updateMany({
      where: { artifactId: input.artifactId, revokedAt: null },
      data: { revokedAt: input.now },
    })
    const grants = await tx.artifactGrant.deleteMany({ where: { artifactId: input.artifactId } })
    return { links: links.count, grants: grants.count }
  })
}

/** «Выйти» of a recipient: their own grants go; the owner never leaves their artifact. */
export async function leaveArtifactAccess(
  db: Db,
  input: { artifactId: string; userId: string },
): Promise<{ left: boolean }> {
  return db.$transaction(async (tx) => {
    await lockArtifact(tx, input.artifactId)
    const { count } = await tx.artifactGrant.deleteMany({
      where: { artifactId: input.artifactId, userId: input.userId },
    })
    return { left: count > 0 }
  })
}
