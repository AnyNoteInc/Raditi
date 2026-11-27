import {
  accountSkillLimits,
  skillSourceNotFound,
  skillSourceUnavailable,
  type SkillRepoRef,
} from '@repo/domain'
import { z } from 'zod'

// Public repositories of GitHub and gitlab.com read without any credential of the client
// (docs/plan/97-skills.md, Нв8, Нв10): the commit a reference names, the tree at that commit, and
// the bytes of a file at it. The hosts are fixed — never one the client names — so nothing here
// can be pointed at a private network. Every answer is bounded.

/** One file of the tree of a commit. */
export interface RepoTreeFile {
  path: string
  /** `100755` — executable; `120000` — a link; `100644` — a plain file. */
  mode: string
  size?: number
}

export interface RepoReader {
  /** The full commit a reference names; the default branch when it names none. */
  commit(ref: SkillRepoRef): Promise<string>
  /** Every file of the tree at `commit` (blobs only). */
  tree(ref: SkillRepoRef, commit: string): Promise<RepoTreeFile[]>
  /** The bytes of a file at `commit`, at most `maxBytes`. */
  file(ref: SkillRepoRef, commit: string, path: string, maxBytes: number): Promise<Uint8Array>
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 20_000
/** A tree of a big repository: anthropics/skills is ~1 MiB of JSON. */
const TREE_BYTES = 16 * 1024 * 1024
const JSON_BYTES = 1024 * 1024
const USER_AGENT = 'raditi-skills'

/** The body of an answer, refused past `max` bytes as it comes. */
async function bodyOf(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > max) throw skillSourceUnavailable()
  if (!response.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > max) throw skillSourceUnavailable()
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

class HttpReader {
  readonly #fetch: Fetch
  readonly #headers: Record<string, string>

  constructor(fetchFn: Fetch, headers: Record<string, string>) {
    this.#fetch = fetchFn
    this.#headers = headers
  }

  async get(url: string, max: number): Promise<Uint8Array> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { 'user-agent': USER_AGENT, ...this.#headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw skillSourceUnavailable()
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel()
      throw skillSourceNotFound()
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw skillSourceUnavailable()
    }
    return bodyOf(response, max)
  }

  async json<T>(url: string, schema: z.ZodType<T>, max = JSON_BYTES): Promise<T> {
    const bytes = await this.get(url, max)
    let data: unknown
    try {
      data = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw skillSourceUnavailable()
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success) throw skillSourceUnavailable()
    return parsed.data
  }
}

const sha = z.string().regex(/^[0-9a-f]{40}$/u)
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** GitHub: the REST API for the commit and the tree, raw.githubusercontent.com for the files. */
export class GithubRepoReader implements RepoReader {
  readonly #http: HttpReader

  constructor(fetchFn: Fetch = fetch) {
    this.#http = new HttpReader(fetchFn, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    })
  }

  async commit(ref: SkillRepoRef): Promise<string> {
    const answer = await this.#http.json(
      `https://api.github.com/repos/${encodePath(ref.repo)}/commits/${encodeURIComponent(ref.ref ?? 'HEAD')}`,
      z.looseObject({ sha }),
    )
    return answer.sha
  }

  async tree(ref: SkillRepoRef, commit: string): Promise<RepoTreeFile[]> {
    const answer = await this.#http.json(
      `https://api.github.com/repos/${encodePath(ref.repo)}/git/trees/${sha.parse(commit)}?recursive=1`,
      z.looseObject({
        truncated: z.boolean().optional(),
        tree: z.array(
          z.looseObject({
            path: z.string(),
            mode: z.string(),
            type: z.string(),
            size: z.number().optional(),
          }),
        ),
      }),
      TREE_BYTES,
    )
    // A tree too big for one answer is too big a repository to search.
    if (answer.truncated) throw skillSourceUnavailable()
    return answer.tree
      .filter((item) => item.type === 'blob')
      .map((item) => ({
        path: item.path,
        mode: item.mode,
        ...(item.size !== undefined ? { size: item.size } : {}),
      }))
  }

  file(ref: SkillRepoRef, commit: string, path: string, maxBytes: number): Promise<Uint8Array> {
    return this.#http.get(
      `https://raw.githubusercontent.com/${encodePath(ref.repo)}/${sha.parse(commit)}/${encodePath(path)}`,
      maxBytes,
    )
  }
}

/** gitlab.com: the REST API v4 for all three; the tree comes in pages of 100. */
export class GitlabRepoReader implements RepoReader {
  readonly #http: HttpReader

  constructor(fetchFn: Fetch = fetch) {
    this.#http = new HttpReader(fetchFn, { accept: 'application/json' })
  }

  #project(ref: SkillRepoRef): string {
    return `https://gitlab.com/api/v4/projects/${encodeURIComponent(ref.repo)}`
  }

  async commit(ref: SkillRepoRef): Promise<string> {
    let name = ref.ref
    if (!name) {
      const project = await this.#http.json(
        this.#project(ref),
        z.looseObject({ default_branch: z.string().nullable() }),
      )
      if (!project.default_branch) throw skillSourceNotFound()
      name = project.default_branch
    }
    const answer = await this.#http.json(
      `${this.#project(ref)}/repository/commits/${encodeURIComponent(name)}`,
      z.looseObject({ id: sha }),
    )
    return answer.id
  }

  async tree(ref: SkillRepoRef, commit: string): Promise<RepoTreeFile[]> {
    const files: RepoTreeFile[] = []
    const item = z.looseObject({ path: z.string(), mode: z.string(), type: z.string() })
    // At most 200 pages: 20 000 entries.
    for (let page = 1; page <= 200; page += 1) {
      const items = await this.#http.json(
        `${this.#project(ref)}/repository/tree?ref=${sha.parse(commit)}&recursive=true&per_page=100&page=${page}`,
        z.array(item),
      )
      for (const entry of items)
        if (entry.type === 'blob') files.push({ path: entry.path, mode: entry.mode })
      if (items.length < 100) return files
    }
    throw skillSourceUnavailable()
  }

  file(ref: SkillRepoRef, commit: string, path: string, maxBytes: number): Promise<Uint8Array> {
    return this.#http.get(
      `${this.#project(ref)}/repository/files/${encodeURIComponent(path)}/raw?ref=${sha.parse(commit)}`,
      maxBytes,
    )
  }
}

/** The reader of the host of a repository. */
export interface RepoReaders {
  github: RepoReader
  gitlab: RepoReader
}

export const repoReaders = (fetchFn: Fetch = fetch): RepoReaders => ({
  github: new GithubRepoReader(fetchFn),
  gitlab: new GitlabRepoReader(fetchFn),
})

export const MARKETPLACE_FILE_BYTES = accountSkillLimits.marketplaceBytes
