import { z } from 'zod'

import { marketplaceInvalid } from './errors.ts'
import { accountSkillLimits } from './limits.ts'
import { joinRepoPath, skillRepoRefSchema, type SkillRepoRef } from './sources.ts'

// A marketplace (docs/plan/97-skills.md, Нв7): `.claude-plugin/marketplace.json` of Claude Code,
// which Codex reads too, or `.agents/plugins/marketplace.json` of Codex — the same shape. Of a
// plugin the platform takes its skills only: commands, agents, hooks and MCP servers are not
// installed. The sources read: a relative path, `github`, `git-subdir`, `url` of a git host the
// platform reads; `npm`, `archive` and `command` run code of someone else to install and are left
// out.

export const MARKETPLACE_FILES = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
] as const

const text = (max: number) => z.string().max(max)

const pluginSourceSchema = z.union([
  z.string().max(512),
  z.looseObject({
    source: z.string().max(32),
    repo: text(256).optional(),
    url: text(512).optional(),
    path: text(512).optional(),
    ref: text(128).optional(),
    sha: text(64).optional(),
  }),
])

const pluginSchema = z.looseObject({
  name: text(128),
  description: text(2000).optional(),
  source: pluginSourceSchema,
  /** `strict: false` entries of anthropics/skills list their skill folders here. */
  skills: z.array(text(512)).max(200).optional(),
  version: text(64).optional(),
  category: text(64).optional(),
})

export const marketplaceManifestSchema = z.looseObject({
  name: text(128),
  owner: z.looseObject({ name: text(256) }).optional(),
  metadata: z
    .looseObject({ description: text(2000).optional(), pluginRoot: text(512).optional() })
    .optional(),
  plugins: z.array(z.unknown()).max(accountSkillLimits.marketplacePlugins),
})

/** One plugin of a marketplace, as the catalog shows it, with where its skills are. */
export interface MarketplacePlugin {
  name: string
  description?: string
  /** The repository and folder the skills of the plugin are found in. */
  repo: SkillRepoRef
  /**
   * The folders of its skills inside `repo.path`, when the entry lists them (`skills: [...]`);
   * absent — every `skills/<name>/SKILL.md` of the plugin's folder.
   */
  skillFolders?: string[]
}

/**
 * The plugins of a marketplace whose skills the platform can read, in the order of the file.
 * `home` is the repository the file lies in: relative sources are inside it. Entries the platform
 * does not read — an unknown or a code-running source, a host it does not read — are left out;
 * a file that is not a marketplace is MARKETPLACE_INVALID.
 */
export function marketplacePlugins(data: unknown, home: SkillRepoRef): MarketplacePlugin[] {
  const manifest = marketplaceManifestSchema.safeParse(data)
  if (!manifest.success) throw marketplaceInvalid()
  const root = manifest.data.metadata?.pluginRoot ?? ''
  const plugins: MarketplacePlugin[] = []
  const seen = new Set<string>()
  for (const raw of manifest.data.plugins) {
    const entry = pluginSchema.safeParse(raw)
    if (!entry.success || seen.has(entry.data.name)) continue
    const repo = pluginRepo(entry.data.source, home, root)
    if (!repo) continue
    seen.add(entry.data.name)
    const folders = entry.data.skills
      ?.map((folder) => joinRepoPath(folder))
      .filter((folder) => folder !== '' && !folder.split('/').includes('..'))
    plugins.push({
      name: entry.data.name,
      ...(entry.data.description ? { description: entry.data.description } : {}),
      repo,
      ...(folders?.length ? { skillFolders: folders } : {}),
    })
  }
  return plugins
}

function pluginRepo(
  source: z.infer<typeof pluginSourceSchema>,
  home: SkillRepoRef,
  root: string,
): SkillRepoRef | null {
  if (typeof source === 'string') {
    if (!source.startsWith('./') && source !== '.') return null
    return repoOf({ ...home, path: joinRepoPath(home.path, root, source) })
  }
  const ref = source.sha ?? source.ref
  switch (source.source) {
    case 'github':
      return source.repo
        ? repoOf({ host: 'github', repo: source.repo, path: joinRepoPath(source.path ?? ''), ref })
        : null
    case 'git-subdir':
    case 'url': {
      const repo = source.url ? gitHostRepo(source.url) : null
      return repo ? repoOf({ ...repo, path: joinRepoPath(source.path ?? ''), ref }) : null
    }
    default:
      return null
  }
}

/** `owner/repo`, or a git URL of GitHub or gitlab.com, as a repository the platform reads. */
function gitHostRepo(url: string): Pick<SkillRepoRef, 'host' | 'repo'> | null {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url)) return { host: 'github', repo: url }
  const parsed = URL.parse(url)
  if (!parsed || parsed.protocol !== 'https:') return null
  const repo = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if (parsed.hostname === 'github.com') return { host: 'github', repo }
  if (parsed.hostname === 'gitlab.com') return { host: 'gitlab', repo }
  return null
}

function repoOf(ref: { host: string; repo: string; path: string; ref?: string | undefined }) {
  const parsed = skillRepoRefSchema.safeParse(
    ref.ref === undefined ? { host: ref.host, repo: ref.repo, path: ref.path } : ref,
  )
  return parsed.success ? parsed.data : null
}
