import { z } from 'zod'

import { skillSourceInvalid } from './errors.ts'

// Where a skill comes from (docs/plan/97-skills.md, Нв5–Нв9, Нв20). A repository is one of GitHub or
// GitLab (gitlab.com) and public: the platform reads it without any credential of the client, by
// the fixed addresses of the provider only — the host is never the client's.

/**
 * `builtin` — a skill of the sandbox image, the catalog of Радити among them (Нв5, Нв6); the others
 * are versions the platform keeps in raditi-inbox.
 */
export const skillSourceKinds = ['builtin', 'marketplace', 'git', 'upload', 'created'] as const
export type SkillSourceKind = (typeof skillSourceKinds)[number]

export const skillRepoHosts = ['github', 'gitlab'] as const
export type SkillRepoHost = (typeof skillRepoHosts)[number]

/** A path inside a repository: relative, clean, no `..`. Empty — its root. */
const repoPath = z
  .string()
  .max(512)
  .refine(
    (path) =>
      path === '' ||
      (!path.startsWith('/') &&
        !path.endsWith('/') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        !/[\\\s?#%]/u.test(path)),
    'expected a clean path inside a repository',
  )

/** `owner/repo` of GitHub; `group/…/project` of GitLab. */
const repoName = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u)
  .refine((name) => !name.split('/').some((part) => part === '.' || part === '..'))

/** A branch, a tag or a commit, as a provider takes it in an address. */
const gitRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u)
  .refine((ref) => !ref.includes('..') && !ref.endsWith('/') && !ref.endsWith('.lock'))

export const skillRepoRefSchema = z
  .object({
    host: z.enum(skillRepoHosts),
    repo: repoName,
    /** Absent — the default branch. */
    ref: gitRef.optional(),
    /** The folder of the skill, or of the search for skills; '' — the root. */
    path: repoPath,
  })
  .strict()
export type SkillRepoRef = z.infer<typeof skillRepoRefSchema>

/** What `account_skills.source_ref` keeps of each source. */
export const skillSourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }).strict(),
  z.object({ kind: z.literal('upload'), fileName: z.string().max(255) }).strict(),
  z.object({ kind: z.literal('created'), taskId: z.uuid() }).strict(),
  z.object({ kind: z.literal('git'), repo: skillRepoRefSchema }).strict(),
  z
    .object({
      kind: z.literal('marketplace'),
      marketplaceId: z.uuid(),
      plugin: z.string().max(128),
      repo: skillRepoRefSchema,
    })
    .strict(),
])
export type SkillSourceRef = z.infer<typeof skillSourceRefSchema>

/**
 * The repository an address the client typed names (Нв8):
 * - `owner/repo` — GitHub, its root;
 * - `https://github.com/owner/repo[/tree/<ref>/<path>]` (also `/blob/<ref>/<path>/SKILL.md`);
 * - `https://gitlab.com/group/…/project[/-/tree/<ref>/<path>]`.
 *
 * A reference with a `/` in its name is not told from its path: the first part is the reference.
 * SKILL_SOURCE_INVALID for anything else.
 */
export function parseSkillRepoAddress(input: string): SkillRepoRef {
  const value = input.trim().replace(/\.git$/u, '')
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(value)
  if (short) return checked({ host: 'github', repo: short[1]!, path: '' })
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port)
    throw skillSourceInvalid()
  const parts = url.pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part))
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const [owner, repo, mode, ref, ...rest] = parts
    if (!owner || !repo) throw skillSourceInvalid()
    if (mode === undefined) return checked({ host: 'github', repo: `${owner}/${repo}`, path: '' })
    if ((mode !== 'tree' && mode !== 'blob') || !ref) throw skillSourceInvalid()
    return checked({
      host: 'github',
      repo: `${owner}/${repo}`,
      ref,
      path: withoutSkillMd(rest).join('/'),
    })
  }
  if (url.hostname === 'gitlab.com') {
    const dash = parts.indexOf('-')
    const project = dash === -1 ? parts : parts.slice(0, dash)
    if (project.length < 2) throw skillSourceInvalid()
    if (dash === -1) return checked({ host: 'gitlab', repo: project.join('/'), path: '' })
    const [mode, ref, ...rest] = parts.slice(dash + 1)
    if ((mode !== 'tree' && mode !== 'blob') || !ref) throw skillSourceInvalid()
    return checked({
      host: 'gitlab',
      repo: project.join('/'),
      ref,
      path: withoutSkillMd(rest).join('/'),
    })
  }
  throw skillSourceInvalid()
}

const withoutSkillMd = (parts: string[]) =>
  parts.at(-1) === 'SKILL.md' ? parts.slice(0, -1) : parts

function checked(ref: SkillRepoRef): SkillRepoRef {
  const parsed = skillRepoRefSchema.safeParse(ref)
  if (!parsed.success) throw skillSourceInvalid()
  return parsed.data
}

/** The page of the source a client opens: the folder at the commit installed, when known. */
export function skillRepoWebUrl(ref: SkillRepoRef, commit?: string | null): string {
  const at = commit ?? ref.ref
  if (ref.host === 'github')
    return at
      ? `https://github.com/${ref.repo}/tree/${at}${ref.path ? `/${ref.path}` : ''}`
      : `https://github.com/${ref.repo}`
  return at
    ? `https://gitlab.com/${ref.repo}/-/tree/${at}${ref.path ? `/${ref.path}` : ''}`
    : `https://gitlab.com/${ref.repo}`
}

/** A path joined to a folder of a repository. */
export const joinRepoPath = (...parts: string[]): string =>
  parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '' && part !== '.')
    .join('/')
