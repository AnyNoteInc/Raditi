import { createHash, randomBytes } from 'node:crypto'

import {
  artifactGrantAllowed,
  artifactGrantRefused,
  artifactInviteDays,
  artifactInviteGone,
  artifactInviteLimits,
  artifactKindSpecOf,
  artifactLimit,
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
  invites: { id: string; email: string; role: string; createdAt: Date }[]
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
        invites: await artifactInvitesOf(tx, input),
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
    // The waiting invitations close too, their addresses gone.
    await tx.artifactInvite.updateMany({
      where: { artifactId: input.artifactId, acceptedAt: null, closedAt: null },
      data: { closedAt: input.now, email: null },
    })
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

// ———————————————————————————————— invitations (Ар35, slice 88.16-2)

export interface ArtifactInviteSent {
  inviteId: string
  kind: string
  inviterName: string
}

/**
 * «Пригласить» by an address the owner typed, in the caller's transaction (the letter goes to the
 * outbox in it). The owner sees only the address and «Приглашение отправлено» — whether it has an
 * account is never told (Ар35). A waiting one to the same address gets the new role and goes again.
 */
export async function inviteToArtifact(
  tx: Tx,
  input: {
    artifactId: string
    userId: string
    email: string
    role: ArtifactOpenGrantRole
    now: Date
  },
): Promise<ArtifactInviteSent> {
  const artifact = await lockShared(tx, input)
  requireGrantable(artifact.kind, input.role)
  const inviter = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { name: true, email: true },
  })
  if (inviter.email.toLowerCase() === input.email) throw artifactGrantRefused()
  const dayAgo = new Date(input.now.getTime() - DAY_MS)
  const [byUser, byArtifact] = await Promise.all([
    tx.artifactInvite.count({ where: { invitedBy: input.userId, createdAt: { gt: dayAgo } } }),
    tx.artifactInvite.count({ where: { artifactId: artifact.id, createdAt: { gt: dayAgo } } }),
  ])
  if (
    byUser >= artifactInviteLimits.perUserDay ||
    byArtifact >= artifactInviteLimits.perArtifactDay
  )
    throw artifactLimit('invites')
  const expiresAt = new Date(input.now.getTime() + artifactInviteDays * DAY_MS)
  const waiting = await tx.artifactInvite.findFirst({
    where: { artifactId: artifact.id, email: input.email, acceptedAt: null, closedAt: null },
    select: { id: true },
  })
  // A repeat is a new row: the limits count what was sent, and the old one closes.
  if (waiting)
    await tx.artifactInvite.update({
      where: { id: waiting.id },
      data: { closedAt: input.now, email: null },
    })
  const invite = await tx.artifactInvite.create({
    data: {
      artifactId: artifact.id,
      email: input.email,
      role: input.role,
      invitedBy: input.userId,
      createdAt: input.now,
      expiresAt,
    },
    select: { id: true },
  })
  return { inviteId: invite.id, kind: artifact.kind, inviterName: inviter.name }
}

/** «Отозвать приглашение» of the owner: the address goes with it. */
export async function revokeArtifactInvite(
  db: Db,
  input: { artifactId: string; userId: string; inviteId: string; now: Date },
): Promise<{ revoked: boolean }> {
  return db.$transaction(async (tx) => {
    await lockShared(tx, input)
    const { count } = await tx.artifactInvite.updateMany({
      where: { id: input.inviteId, artifactId: input.artifactId, acceptedAt: null, closedAt: null },
      data: { closedAt: input.now, email: null },
    })
    return { revoked: count > 0 }
  })
}

/** The waiting invitations of an owner's artifact: the address, the role, when. */
export async function artifactInvitesOf(
  tx: Tx,
  input: { artifactId: string; now: Date },
): Promise<{ id: string; email: string; role: string; createdAt: Date }[]> {
  const rows = await tx.artifactInvite.findMany({
    where: {
      artifactId: input.artifactId,
      acceptedAt: null,
      closedAt: null,
      expiresAt: { gt: input.now },
      email: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, role: true, createdAt: true },
  })
  return rows.map((row) => ({ ...row, email: row.email! }))
}

/** The user's confirmed address, or null: an invitation opens only to its confirmed owner. */
async function confirmedEmailOf(tx: Pick<Tx, 'user'>, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  })
  return user?.emailVerified ? user.email.toLowerCase() : null
}

/**
 * «Приглашения» of a signed-in user (§7.8): those waiting for their confirmed address, of a live
 * artifact — who invites, the kind and the title, which they see now, after sign-in.
 */
export async function myArtifactInvites(
  db: Pick<PrismaClient, '$transaction'>,
  input: { userId: string; now: Date },
): Promise<
  {
    inviteId: string
    artifactId: string
    kind: string
    title: string
    ownerName: string
    role: string
  }[]
> {
  return db.$transaction(async (tx) => {
    const email = await confirmedEmailOf(tx, input.userId)
    if (email === null) return []
    const rows = await tx.artifactInvite.findMany({
      where: {
        email,
        acceptedAt: null,
        closedAt: null,
        expiresAt: { gt: input.now },
        artifact: { deletedAt: null, takenDownAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        role: true,
        artifact: {
          select: { id: true, kind: true, title: true, owner: { select: { name: true } } },
        },
      },
    })
    return rows.map((row) => ({
      inviteId: row.id,
      artifactId: row.artifact.id,
      kind: row.artifact.kind,
      title: row.artifact.title,
      ownerName: row.artifact.owner?.name ?? '',
      role: row.role,
    }))
  })
}

/** «Принять» (Ар35): a grant by invitation of its role; the address goes. */
export async function acceptArtifactInvite(
  db: Db,
  input: { userId: string; inviteId: string; now: Date },
): Promise<{ artifactId: string; role: ArtifactRole }> {
  return db.$transaction(async (tx) => {
    const email = await confirmedEmailOf(tx, input.userId)
    const invite = await tx.artifactInvite.findUnique({
      where: { id: input.inviteId },
      select: {
        id: true,
        artifactId: true,
        email: true,
        role: true,
        invitedBy: true,
        acceptedAt: true,
        closedAt: true,
        expiresAt: true,
      },
    })
    if (
      email === null ||
      !invite ||
      invite.email !== email ||
      invite.acceptedAt !== null ||
      invite.closedAt !== null ||
      invite.expiresAt <= input.now
    )
      throw artifactInviteGone()
    const artifact = await lockArtifact(tx, invite.artifactId)
    if (artifact.deletedAt !== null || artifact.takenDownAt !== null) throw artifactInviteGone()
    if ((await artifactRole(tx, { artifactId: artifact.id, userId: input.userId })) === 'owner')
      throw artifactInviteGone()
    const granted = await tx.artifactGrant.findFirst({
      where: { artifactId: artifact.id, userId: input.userId, source: 'invite' },
      select: { id: true },
    })
    if (granted)
      await tx.artifactGrant.update({ where: { id: granted.id }, data: { role: invite.role } })
    else
      await tx.artifactGrant.create({
        data: {
          artifactId: artifact.id,
          userId: input.userId,
          source: 'invite',
          role: invite.role,
          grantedBy: invite.invitedBy,
        },
      })
    await tx.artifactInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: input.now, acceptedBy: input.userId, email: null },
    })
    const role = await artifactRole(tx, { artifactId: artifact.id, userId: input.userId })
    if (role === null) throw artifactInviteGone()
    return { artifactId: artifact.id, role }
  })
}

/** «Отклонить»: the invitation closes, its address goes; the owner sees it no more. */
export async function declineArtifactInvite(
  db: Db,
  input: { userId: string; inviteId: string; now: Date },
): Promise<{ declined: boolean }> {
  return db.$transaction(async (tx) => {
    const email = await confirmedEmailOf(tx, input.userId)
    if (email === null) return { declined: false }
    const { count } = await tx.artifactInvite.updateMany({
      where: { id: input.inviteId, email, acceptedAt: null, closedAt: null },
      data: { closedAt: input.now, email: null },
    })
    return { declined: count > 0 }
  })
}
