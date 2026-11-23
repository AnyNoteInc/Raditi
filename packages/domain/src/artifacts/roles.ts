import type { ArtifactKind } from './kinds.ts'
import { artifactKindSpecs } from './kinds.ts'

/**
 * Who may do what with an artifact (docs/plan/88-artifacts.md, Ар23, Ар34, Ар36–Ар38, §7.8).
 * `artifactRole` of `@repo/db` gives one of these on every path; these pure rules say what it
 * allows. Only the owner shares; the strongest live grant wins; the agent never shares.
 */

export const artifactRoles = ['view', 'comment', 'edit', 'owner'] as const
export type ArtifactRole = (typeof artifactRoles)[number]

/** The roles a grant gives — a link or an invitation; the owner is never granted. */
export const artifactGrantRoles = ['view', 'comment', 'edit'] as const
export type ArtifactGrantRole = (typeof artifactGrantRoles)[number]

/** What the client reads (Ар36, rule 10). */
export const artifactRoleLabels = Object.freeze({
  view: 'Смотрит',
  comment: 'Комментирует',
  edit: 'Правит',
  owner: 'Владелец',
} satisfies Record<ArtifactRole, string>)

const rankOf = (role: ArtifactRole): number => artifactRoles.indexOf(role)

/** Whether a role gives at least another one; null — no access at all. */
export function artifactRoleAtLeast(role: ArtifactRole | null, needed: ArtifactRole): boolean {
  return role !== null && rankOf(role) >= rankOf(needed)
}

/** The strongest of these roles (Ар34): of the live grants of one user; null — none. */
export function strongestArtifactRole(
  roles: Iterable<ArtifactRole | null | undefined>,
): ArtifactRole | null {
  let best: ArtifactRole | null = null
  for (const role of roles) if (role && (best === null || rankOf(role) > rankOf(best))) best = role
  return best
}

/**
 * What one may do. `read` — open and read; `comment`; `edit` — write blocks; the rest only the
 * owner (Ар23): publish and update the page, trash and restore, move to a project or make personal,
 * share and change access, return a version. The agent of a chat acts with the role of the
 * client of that chat, and the actions it has no tool for (`share`, `restore_version`,
 * `purge_trash`) stay with the cabinet.
 */
export const artifactActions = [
  'read',
  'comment',
  'edit',
  'publish',
  'trash',
  'move',
  'share',
  'restore_version',
  'purge_trash',
] as const
export type ArtifactAction = (typeof artifactActions)[number]

const neededRole = {
  read: 'view',
  comment: 'comment',
  edit: 'edit',
  publish: 'owner',
  trash: 'owner',
  move: 'owner',
  share: 'owner',
  restore_version: 'owner',
  purge_trash: 'owner',
} as const satisfies Record<ArtifactAction, ArtifactRole>

export function artifactRoleCan(role: ArtifactRole | null, action: ArtifactAction): boolean {
  return artifactRoleAtLeast(role, neededRole[action])
}

/** The actions no tool of the agent ever does (Ар23, rule 4): only a person in the cabinet. */
export const artifactCabinetOnlyActions: readonly ArtifactAction[] = Object.freeze([
  'share',
  'restore_version',
  'purge_trash',
])

/**
 * Whether a grant of this role may be given on an artifact of this kind: a kind that goes into
 * every turn of a project («Фирменный стиль») never opens with «Правит» (Ар25).
 */
export function artifactGrantAllowed(kind: ArtifactKind, role: ArtifactGrantRole): boolean {
  return role !== 'edit' || artifactKindSpecs[kind].sharableEdit
}

export type ArtifactDataClass = 'synthetic' | 'client'

/**
 * Whether a reader of this class may read an artifact of that class (Ар23, Ар38, §7.8): the data
 * of a client go only to `client` — a `synthetic` turn or copy never reads them. Synthetic data go
 * anywhere.
 */
export function artifactDataClassAllows(
  reader: ArtifactDataClass,
  artifact: ArtifactDataClass,
): boolean {
  return artifact !== 'client' || reader === 'client'
}
