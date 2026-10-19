import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import type { PrismaClient } from '@repo/db'
import {
  dbStateHashMaterial,
  DomainError,
  siteAccessPath,
  type DbAbsentState,
  type DbObjectState,
  type DbOperation,
  type DbOptionState,
  type DbPlanView,
  type DbTableState,
  type DbWriteProof,
  type GitTag,
  type PresignedRequest,
  type PresignRequest,
  type PublishedContentState,
  type RepoRef,
  type SiteContentGateway,
  type SiteDbCapabilities,
  type WorkflowDispatch,
  type WorkflowRun,
  type WrappedSecret,
} from '@repo/domain'

import type {
  ChangeDigest,
  ReleaseGit,
  TrustedCommitInput,
  TrustedCommitPush,
} from '../git-workspace/release-git.ts'

// Stand-ins of the world outside PostgreSQL for the tests of releases (docs/plan/53-chat-preview-
// release.md, R8b): the site's repository with its `main`, the provider as the release account,
// Vault and S3, each with one-shot failures — before the call does anything, or after it did
// (a lost answer). And the rows of a dialog waiting for its release, as web leaves them at the
// confirmation. Test files only.

/**
 * One-shot failures: `before` — nothing happened; `after` — it happened, the answer was lost;
 * `final` — the provider refused for good (R8a: `details.reason`); `not_configured` — the
 * release account has no token in Vault.
 */
type Failure = 'before' | 'after' | 'final' | 'not_configured'

class Failures<Name extends string> {
  readonly #next = new Map<Name, Failure>()

  set(name: Name, failure: Failure = 'before'): void {
    this.#next.set(name, failure)
  }

  /** Runs `act` unless a failure of `name` is set, which it then consumes. */
  async run<T>(name: Name, act: () => T | Promise<T>): Promise<T> {
    const failure = this.#next.get(name)
    this.#next.delete(name)
    if (failure === 'final')
      throw new DomainError('GIT_PROVIDER_FAILED', `${name} refused`, 502, { reason: 'invalid' })
    if (failure === 'not_configured')
      throw new DomainError('GIT_PROVIDER_NOT_CONFIGURED', `${name}: no owner token`, 503)
    if (failure === 'before') throw new Error(`${name} did not answer`)
    const result = await act()
    if (failure === 'after') throw new Error(`${name} answer lost`)
    return result
  }
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** The installed commit of the site, the head of the candidate, and their trees. */
export const INSTALLED_SHA = 'a'.repeat(40)
export const INSTALLED_TREE = '1'.repeat(40)
export const CANDIDATE_HEAD = 'b'.repeat(40)
export const CANDIDATE_TREE = '2'.repeat(40)

/**
 * `main` of the site's repository and the commits of the platform on it: a commit's SHA is a
 * function of its tree, parent, message and instant, as git's.
 */
export class FakeReleaseGit implements ReleaseGit {
  main: string = INSTALLED_SHA
  readonly trees = new Map<string, string>([
    [INSTALLED_SHA, INSTALLED_TREE],
    [CANDIDATE_HEAD, CANDIDATE_TREE],
  ])
  readonly parents = new Map<string, string>()
  readonly pushes: string[] = []
  readonly fail = new Failures<
    'readBranchHead' | 'treeOf' | 'trustedCommit' | 'pushTrustedCommit'
  >()
  digests: ChangeDigest[] = [
    {
      path: 'wp-content/themes/site/header.php',
      change: 'modified',
      before: 'c'.repeat(64),
      after: 'd'.repeat(64),
      sizeBytes: 120,
      executable: false,
    },
    {
      path: 'wp-content/themes/site/old.css',
      change: 'deleted',
      before: 'e'.repeat(64),
      after: null,
      sizeBytes: 0,
      executable: false,
    },
  ]

  /** Someone else's commit on `main`. */
  moveMain(): string {
    const sha = sha1(`foreign:${this.main}`)
    this.trees.set(sha, '9'.repeat(40))
    this.parents.set(sha, this.main)
    this.main = sha
    return sha
  }

  readBranchHead = (input: { repo: RepoRef; branch: string }): Promise<string | null> =>
    this.fail.run('readBranchHead', () => (input.branch === 'main' ? this.main : null))

  treeOf = (input: { repo: RepoRef; sha: string }): Promise<string> =>
    this.fail.run('treeOf', () => {
      const tree = this.trees.get(input.sha)
      if (!tree) throw new Error(`No commit ${input.sha}`)
      return tree
    })

  #commit(input: TrustedCommitInput): string {
    const base = this.trees.get(input.treeOf)
    if (!base) throw new Error(`No commit ${input.treeOf}`)
    const tree =
      input.overlay && input.overlay.paths.length > 0
        ? sha1(JSON.stringify([base, input.overlay.from, [...input.overlay.paths].sort()]))
        : base
    const sha = sha1(JSON.stringify([tree, input.parent, input.message, input.committedAt]))
    this.trees.set(sha, tree)
    this.parents.set(sha, input.parent)
    return sha
  }

  trustedCommit = (input: TrustedCommitInput): Promise<string> =>
    this.fail.run('trustedCommit', () => this.#commit(input))

  pushTrustedCommit = (
    input: TrustedCommitInput & { branch: string; expected: string },
    assertFence: () => Promise<void>,
  ): Promise<TrustedCommitPush> =>
    this.fail.run('pushTrustedCommit', async () => {
      const sha = this.#commit(input)
      if (this.main === sha) return { status: 'present', sha }
      if (this.main !== input.expected) return { status: 'moved', sha, remote: this.main }
      await assertFence()
      this.main = sha
      this.pushes.push(sha)
      return { status: 'pushed', sha }
    })

  changeDigests = async (): Promise<ChangeDigest[]> => this.digests

  /**
   * The tree of `treeOf` with the overlay of another commit: a tree of its own for each input, as
   * git's would be.
   */
  treeWith = (input: {
    repo: RepoRef
    treeOf: string
    overlay: { from: string; paths: readonly string[] }
  }): Promise<string> =>
    this.fail.run('treeOf', () => {
      const tree = this.trees.get(input.treeOf)
      if (!tree) throw new Error(`No commit ${input.treeOf}`)
      return input.overlay.paths.length === 0
        ? tree
        : sha1(JSON.stringify([tree, input.overlay.from, [...input.overlay.paths].sort()]))
    })
}

/**
 * The provider as the release account: tags, their protection and repository secrets; and the
 * runs of the deploy workflow, as the test puts them (`runs`).
 */
export class FakeReleaseProvider {
  readonly tags = new Map<string, string>()
  readonly protectedPatterns: string[] = []
  readonly secrets = new Map<string, string>()
  /** Every call in order, by name. */
  readonly calls: string[] = []
  /** Workflows started by hand: the run of an attempt «только возврат». */
  readonly dispatches: Array<WorkflowDispatch & { repo: RepoRef }> = []
  /** Runs of workflows the provider shows: none unless a test adds them. */
  readonly runs: WorkflowRun[] = []
  readonly fail = new Failures<
    | 'protectTags'
    | 'getTag'
    | 'createTag'
    | 'setActionsSecret'
    | 'deleteActionsSecret'
    | 'dispatchWorkflow'
    | 'listWorkflowRuns'
    | 'getWorkflowRun'
  >()

  /** A run of `deploy.yml` on the tag, as Gitea's REST API shows it (R8a, R8c). */
  deployRun(input: {
    id: string
    tag: string
    sha: string
    status: WorkflowRun['status']
    event?: 'push' | 'workflow_dispatch'
  }): WorkflowRun {
    const run: WorkflowRun = {
      id: input.id,
      name: 'deploy.yml',
      headSha: input.sha,
      status: input.status,
      conclusion: input.status === 'completed' ? 'failure' : null,
      url: `https://git.invalid/runs/${input.id}`,
      workflowFile: 'deploy.yml',
      workflowPath: null,
      ref: `refs/tags/${input.tag}`,
      event: input.event ?? 'push',
      headBranch: null,
      runAttempt: 1,
    }
    const at = this.runs.findIndex((known) => known.id === run.id)
    if (at >= 0) this.runs[at] = run
    else this.runs.push(run)
    return run
  }

  listWorkflowRuns = (
    _ref: RepoRef,
    filter: { headSha?: string; event?: string; branch?: string },
  ): Promise<WorkflowRun[]> =>
    this.fail.run('listWorkflowRuns', () =>
      this.runs.filter(
        (run) =>
          (filter.headSha === undefined || run.headSha === filter.headSha) &&
          (filter.event === undefined || run.event === filter.event),
      ),
    )

  getWorkflowRun = (_ref: RepoRef, id: string): Promise<WorkflowRun | null> =>
    this.fail.run('getWorkflowRun', () => this.runs.find((run) => run.id === id) ?? null)

  protectTags = (_ref: RepoRef, pattern: string): Promise<void> =>
    this.fail.run('protectTags', () => {
      this.calls.push('protectTags')
      if (!this.protectedPatterns.includes(pattern)) this.protectedPatterns.push(pattern)
    })

  getTag = (_ref: RepoRef, name: string): Promise<GitTag | null> =>
    this.fail.run('getTag', () => {
      const sha = this.tags.get(name)
      return sha ? { name, commitSha: sha, objectSha: sha } : null
    })

  createTag = (_ref: RepoRef, name: string, commitSha: string): Promise<GitTag> =>
    this.fail.run('createTag', () => {
      this.calls.push('createTag')
      // A taken name is answered as it is: the tag never moves.
      if (!this.tags.has(name)) this.tags.set(name, commitSha)
      const sha = this.tags.get(name)!
      return { name, commitSha: sha, objectSha: sha }
    })

  setActionsSecret = (_ref: RepoRef, name: string, value: string): Promise<void> =>
    this.fail.run('setActionsSecret', () => {
      this.calls.push('setActionsSecret')
      this.secrets.set(name, value)
    })

  deleteActionsSecret = (_ref: RepoRef, name: string): Promise<void> =>
    this.fail.run('deleteActionsSecret', () => {
      this.calls.push('deleteActionsSecret')
      this.secrets.delete(name)
    })

  dispatchWorkflow = (
    repo: RepoRef,
    dispatch: WorkflowDispatch,
  ): Promise<{ runId: string | null }> =>
    this.fail.run('dispatchWorkflow', () => {
      this.calls.push('dispatchWorkflow')
      this.dispatches.push({ ...dispatch, repo })
      return { runId: String(100 + this.dispatches.length) }
    })
}

/** Vault: wrappings with their data, revoked accessors, Transit data keys, KV secrets. */
export class FakeReleaseVault {
  readonly wrappings: Array<WrappedSecret & { data: Record<string, string>; ttl: number }> = []
  readonly revoked: string[] = []
  readonly kv = new Map<string, { data: Record<string, string>; version: number }>()
  /** Data keys by their ciphertext: the caller zeroes the plaintext it was given. */
  readonly dataKeys = new Map<string, Buffer>()
  readonly fail = new Failures<
    'wrap' | 'revokeAccessor' | 'transitDataKey' | 'transitDecryptDataKey'
  >()

  wrap = (data: Record<string, string>, ttlSeconds: number): Promise<WrappedSecret> =>
    this.fail.run('wrap', () => {
      const n = this.wrappings.length + 1
      const wrapped = {
        token: `hvs.wrapping-${n}-${randomBytes(6).toString('hex')}`,
        accessor: `accessor-${n}`,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      }
      this.wrappings.push({ ...wrapped, data: { ...data }, ttl: ttlSeconds })
      return wrapped
    })

  revokeAccessor = (accessor: string): Promise<void> =>
    this.fail.run('revokeAccessor', () => {
      this.revoked.push(accessor)
    })

  transitDataKey = (key: string): Promise<{ plaintext: Uint8Array; ciphertext: string }> =>
    this.fail.run('transitDataKey', () => {
      const plaintext = randomBytes(32)
      const ciphertext = `vault:v1:${key}:${randomBytes(8).toString('hex')}`
      this.dataKeys.set(ciphertext, Buffer.from(plaintext))
      return { plaintext: new Uint8Array(plaintext), ciphertext }
    })

  transitDecryptDataKey = (key: string, ciphertext: string): Promise<Uint8Array> =>
    this.fail.run('transitDecryptDataKey', () => {
      const plaintext = this.dataKeys.get(ciphertext)
      if (!plaintext || !ciphertext.startsWith(`vault:v1:${key}:`)) throw new Error('Not this key')
      return new Uint8Array(plaintext)
    })

  /** Earlier versions of a path, as KV v2 keeps them: a read that names its version gets one. */
  readonly kvHistory = new Map<string, Array<{ data: Record<string, string>; version: number }>>()

  kvRead = async (path: string, options: { version?: number } = {}) => {
    const current = this.kv.get(path) ?? null
    if (options.version === undefined || current?.version === options.version) return current
    return this.kvHistory.get(path)?.find((entry) => entry.version === options.version) ?? null
  }

  /** The API token of the latest wrapping: what the deploy job unwraps. */
  latestToken(): string {
    const data = this.wrappings.at(-1)?.data
    if (!data?.releaseApiToken) throw new Error('Nothing was wrapped')
    return data.releaseApiToken
  }
}

/** S3 in memory: objects by bucket and key, presigned requests that name them. */
export class FakeReleaseStorage {
  readonly objects = new Map<string, Buffer>()
  readonly presigned: PresignRequest[] = []

  putIfAbsent = async (bucket: string, key: string, body: Uint8Array): Promise<boolean> => {
    if (this.objects.has(`${bucket}/${key}`)) return false
    this.objects.set(`${bucket}/${key}`, Buffer.from(body))
    return true
  }

  put = async (bucket: string, key: string, body: Uint8Array): Promise<void> => {
    this.objects.set(`${bucket}/${key}`, Buffer.from(body))
  }

  get = async (bucket: string, key: string): Promise<AsyncIterable<Uint8Array> | null> => {
    const body = this.objects.get(`${bucket}/${key}`)
    if (!body) return null
    return (async function* () {
      yield body.subarray(0, Math.ceil(body.byteLength / 2))
      yield body.subarray(Math.ceil(body.byteLength / 2))
    })()
  }

  delete = async (bucket: string, key: string): Promise<void> => {
    this.objects.delete(`${bucket}/${key}`)
  }

  presign = async (request: PresignRequest): Promise<PresignedRequest> => {
    this.presigned.push(request)
    return {
      method: request.method,
      url: `https://s3.invalid/raditi-${request.bucket}/${request.key}?signature=x`,
      headers: request.method === 'PUT' ? { 'if-none-match': '*' } : {},
      expiresAt: new Date(Date.now() + request.ttlMs),
    }
  }
}

/** The values of a candidate's database plan, as the preview's journal would read them back. */
export class FakePlanValues {
  /** The `after` side of each object of the plan. */
  readonly states = new Map<string, DbObjectState>()
  /** The `before` side, where a release reads it (a table). */
  readonly befores = new Map<string, DbObjectState>()
  readonly fail = new Failures<'read'>()

  readState = (
    _owner: { workspaceId: string; taskId: string },
    objectRef: string,
    side: 'before' | 'after',
  ): Promise<{ state: DbObjectState }> =>
    this.fail.run('read', () => {
      const state = (side === 'after' ? this.states : this.befores).get(objectRef)
      if (!state) throw new DomainError('CONFLICT', 'A value failed verification', 409)
      return { state }
    })
}

/** A state with its hash worked out from its fields, as the platform and the plugin do. */
export function hashedState<State extends DbObjectState>(state: Omit<State, 'stateHash'>): State {
  const material = dbStateHashMaterial({
    ...state,
    stateHash: '0'.repeat(64),
  } as unknown as DbObjectState)
  return {
    ...state,
    stateHash: createHash('sha256').update(material).digest('hex'),
  } as State
}

/**
 * One text change of a record of a plan: its operation, the state its `after` value reads back
 * as, and the state production holds before it — every hash worked out from the fields.
 */
export function planOperation(
  objectRef = 'page:42',
  after: Partial<Pick<PublishedContentState, 'title' | 'content' | 'excerpt'>> = {},
): {
  operation: Extract<DbOperation, { kind: 'content_update' }>
  state: PublishedContentState
  before: PublishedContentState
} {
  const value = (n: number) => ({
    key: `previews/${randomUUID()}/${n}.bin`,
    sha256: 'f'.repeat(64),
    sizeBytes: 100,
  })
  const kind = objectRef.split(':')[0] as PublishedContentState['kind']
  const before = hashedState<PublishedContentState>({
    version: 1,
    objectRef,
    kind,
    title: 'Прежний заголовок',
    content: '<p>Текст</p>',
    excerpt: '',
  })
  const state = hashedState<PublishedContentState>({
    version: 1,
    objectRef,
    kind,
    title: 'Новый заголовок',
    content: '<p>Текст</p>',
    excerpt: '',
    ...after,
  })
  return {
    operation: {
      kind: 'content_update',
      objectRef,
      fields: ['title'],
      beforeHash: before.stateHash,
      afterHash: state.stateHash,
      before: value(1),
      after: value(2),
    },
    state,
    before,
  }
}

const planValue = (n: number) => ({
  key: `previews/${randomUUID()}/${n}.bin`,
  sha256: 'f'.repeat(64),
  sizeBytes: 100,
})

/** A setting of a plan: its operation and both its states. */
export function planSetting(
  option = 'blogdescription',
  value = 'Цветы у дома — доставка за час',
): {
  operation: Extract<DbOperation, { kind: 'option_update' }>
  state: DbOptionState
  before: DbOptionState
} {
  const objectRef = `option:${option}`
  const before = hashedState<DbOptionState>({ version: 1, objectRef, value: 'Цветы у дома' })
  const state = hashedState<DbOptionState>({ version: 1, objectRef, value })
  return {
    operation: {
      kind: 'option_update',
      objectRef,
      fields: ['value'],
      beforeHash: before.stateHash,
      afterHash: state.stateHash,
      before: planValue(1),
      after: planValue(2),
    },
    state,
    before,
  }
}

/** A new page of a plan at `slug`: its operation, its state and the absent state before it. */
export function planCreation(
  slug = 'prices',
  objectRef = 'page:1000000001',
): {
  operation: Extract<DbOperation, { kind: 'post_create' }>
  state: PublishedContentState
  before: DbAbsentState
} {
  const before = hashedState<DbAbsentState>({ version: 1, objectRef, absent: true })
  const state = hashedState<PublishedContentState>({
    version: 1,
    objectRef,
    kind: 'page',
    status: 'publish',
    slug,
    title: 'Цены',
    content: '<p>От 500 ₽</p>',
    excerpt: '',
  })
  return {
    operation: {
      kind: 'post_create',
      objectRef,
      fields: ['title', 'content', 'excerpt'],
      beforeHash: before.stateHash,
      afterHash: state.stateHash,
      before: planValue(1),
      after: planValue(2),
    },
    state,
    before,
  }
}

/** A table of the platform a plan creates. */
export function planTable(name = 'bookings'): {
  operation: Extract<DbOperation, { kind: 'schema_migration' }>
  state: DbTableState
  before: DbTableState
} {
  const objectRef = `table:${name}`
  const before = hashedState<DbTableState>({
    version: 1,
    objectRef,
    exists: false,
    managed: false,
    definition: null,
  })
  const state = hashedState<DbTableState>({
    version: 1,
    objectRef,
    exists: true,
    managed: true,
    definition: {
      columns: [{ name: 'starts_at', type: 'datetime', nullable: true }],
      indexes: [],
    },
  })
  return {
    operation: {
      kind: 'schema_migration',
      objectRef,
      fields: ['definition'],
      beforeHash: before.stateHash,
      afterHash: state.stateHash,
      before: planValue(1),
      after: planValue(2),
    },
    state,
    before,
  }
}

/**
 * The description of a plan core keeps with its revision (`task_candidates.db_view`): one card
 * per operation, without values — what the readiness needs of it.
 */
export function planViewOf(plan: readonly DbOperation[], planSha256: string): DbPlanView {
  return {
    v: 1,
    planSha256,
    operations: plan.map((operation, index) =>
      operation.kind === 'content_update'
        ? {
            kind: 'content_update',
            index,
            objectRef: operation.objectRef,
            record: { type: operation.objectRef.split(':')[0]!, title: '' },
            fields: [...operation.fields],
          }
        : operation.kind === 'option_update'
          ? {
              kind: 'option_update',
              index,
              objectRef: operation.objectRef,
              label: 'Настройка',
              before: null,
              after: '',
              truncated: false,
            }
          : operation.kind === 'post_create'
            ? {
                kind: 'post_create',
                index,
                objectRef: operation.objectRef,
                record: { type: operation.objectRef.split(':')[0]! },
                title: 'Новая',
                slug: 'new',
                status: 'publish',
                excerpt: '',
                contentText: '',
                contentBytes: 0,
                links: [],
                truncated: false,
              }
            : {
                kind: 'schema_migration',
                index,
                objectRef: operation.objectRef,
                table: operation.objectRef.slice('table:'.length),
                created: true,
                columns: [],
                indexes: [],
              },
    ),
    truncated: false,
    oversize: false,
  }
}

/**
 * Production's plugin as the readiness of a release asks it: the state of each object (any shape
 * with its hash), the addresses taken, what the plugin can write; `unreachable` — it does not
 * answer.
 */
export class FakeProduction {
  readonly states = new Map<string, { stateHash: string }>()
  readonly taken = new Set<string>()
  /** Receipts of the plugin by call id: what an earlier release wrote, a creation's with its ref. */
  readonly receipts = new Map<string, DbWriteProof>()
  /** Records of the site standing on a record: comments, records below it, menu items. */
  readonly dependentsOf = new Map<string, number>()
  unreachable = false
  capabilities: SiteDbCapabilities = {
    version: 1,
    kind: 'capabilities',
    plugin: 2,
    operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
    settings: ['blogname', 'blogdescription'],
    maxRecordId: 100,
  }

  /** Production holds the base of every operation of `plan`. */
  holdsBaseOf(plan: readonly DbOperation[]): void {
    for (const operation of plan)
      this.states.set(operation.objectRef, { stateHash: operation.beforeHash })
  }

  readonly resolve = async (): Promise<SiteContentGateway> => {
    if (this.unreachable) throw new Error('unreachable')
    const state = async (objectRef: string) => {
      if (this.unreachable) throw new Error('unreachable')
      const found = this.states.get(objectRef)
      if (!found) throw new DomainError('CONTENT_OBJECT_UNAVAILABLE', 'Not readable', 404)
      return { ...found } as never
    }
    return {
      read: state,
      conditionalWrite: () => Promise.reject(new Error('not here')),
      operation: async () => null,
      reconcileOperation: () => Promise.reject(new Error('not here')),
      forgetOperation: async () => undefined,
      db: {
        capabilities: async () => {
          if (this.unreachable) throw new Error('unreachable')
          return { ...this.capabilities }
        },
        readObject: state,
        slugTaken: async (type: string, slug: string) => this.taken.has(`${type}/${slug}`),
        dependents: async (objectRef: string) => {
          if (this.unreachable) throw new Error('unreachable')
          return this.dependentsOf.get(objectRef) ?? 0
        },
        writeObject: () => Promise.reject(new Error('not here')),
        operation: async (callId: string) => {
          if (this.unreachable) throw new Error('unreachable')
          return this.receipts.get(callId) ?? null
        },
        reconcile: () => Promise.reject(new Error('not here')),
        fence: async () => undefined,
      },
    }
  }
}

export interface ReleaseFixtureOptions {
  /** The approver's role in the workspace; `owner` unless given. */
  role?: 'owner' | 'admin' | 'member'
  /** The tree the candidate stands on; the installed tree unless given. */
  baseTree?: string
  /** A check of the candidate that failed. */
  failedCheck?: boolean
  /** No access of the hosting in Vault's references. */
  noHostingAccess?: boolean
  dbPlan?: DbOperation[]
  /**
   * The description of the plan kept with the revision: by default one card per operation;
   * null — none (a candidate recorded before descriptions).
   */
  dbView?: DbPlanView | null
  /** The facts of the candidate as core counted them. */
  facts?: Record<string, number | boolean>
  /** The site's plugin has its access referenced: needed by a plan. */
  contentAccess?: boolean
  version?: string
  /** The status of the site; `active`, as a connected site, unless given. */
  siteStatus?: 'onboarding' | 'active' | 'paused' | 'disconnected' | 'archived'
  /** The file the candidate changes; a file of a theme unless given. */
  candidatePath?: string
}

/**
 * The rows of `billingFixtures` (`@repo/billing/testing`) a release fixture needs: a test file
 * passes them in, so this module does not import test support of another package itself.
 */
export interface ReleaseFixtureRows {
  user(): Promise<{ userId: string }>
  task(
    workspaceId: string,
    data: { status: 'deploying'; turnNo: number },
  ): Promise<{ taskId: string }>
  reserve(placement: {
    workspaceId: string
    taskId: string
    attempt: number
    now: Date
    expiresAt: Date
  }): Promise<unknown>
}

export interface ReleaseFixture {
  userId: string
  workspaceId: string
  siteId: string
  taskId: string
  candidateId: string
  releaseId: string
  repo: RepoRef
}

/**
 * A dialog of a synthetic site whose release the client has just confirmed, as `release.confirm`
 * leaves it (R2): the reserve of its attempt, the dialog `deploying`, its candidate current, the
 * release `approved` with its first wake-up. The site has a repository in Gitea and its code on
 * SFTP, with the access referenced (never stored here).
 */
export async function releaseFixture(
  db: PrismaClient,
  fixtures: ReleaseFixtureRows,
  options: ReleaseFixtureOptions = {},
): Promise<ReleaseFixture> {
  const { userId } = await fixtures.user()
  const workspace = await db.$transaction((tx) =>
    ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
  )
  const { taskId } = await fixtures.task(workspace.id, { status: 'deploying', turnNo: 1 })
  const now = new Date()
  await fixtures.reserve({
    workspaceId: workspace.id,
    taskId,
    attempt: 1,
    now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  })
  if (options.role && options.role !== 'owner')
    await db.member.updateMany({
      where: { workspaceId: workspace.id, userId },
      data: { role: options.role },
    })
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
  const siteId = task.siteId
  await db.site.update({
    where: { id: siteId },
    data: { status: options.siteStatus ?? 'active' },
  })
  const repo: RepoRef = { provider: 'gitea', owner: 'sites', name: `site-${siteId}` }
  await db.gitRepository.create({
    data: {
      siteId,
      provider: 'gitea',
      owner: repo.owner,
      name: repo.name,
      url: `https://git.invalid/sites/site-${siteId}`,
    },
  })
  const ssh = await db.credentialRef.create({
    data: {
      siteId,
      workspaceId: workspace.id,
      kind: 'ssh',
      vaultPath: siteAccessPath(siteId, 'ssh'),
    },
  })
  await db.siteCodeSource.create({
    data: {
      siteId,
      kind: 'sftp',
      host: 'hosting.invalid',
      port: 22,
      rootPath: '/www',
      hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}`,
      credentialRefId: ssh.id,
    },
  })
  if (options.noHostingAccess)
    await db.credentialRef.update({ where: { id: ssh.id }, data: { kind: 'git' } })
  if (options.contentAccess)
    await db.credentialRef.create({
      data: {
        siteId,
        workspaceId: workspace.id,
        kind: 'wp',
        vaultPath: siteAccessPath(siteId, 'wp'),
      },
    })
  const dbPlan = options.dbPlan ?? []
  const planSha256 = createHash('sha256').update(JSON.stringify(dbPlan)).digest('hex')
  const view =
    options.dbView === undefined
      ? dbPlan.length > 0
        ? planViewOf(dbPlan, planSha256)
        : null
      : options.dbView
  const candidate = await db.taskCandidate.create({
    data: {
      taskId,
      revision: 1,
      turnNo: 1,
      baseSha: INSTALLED_SHA,
      baseTree: options.baseTree ?? INSTALLED_TREE,
      headSha: CANDIDATE_HEAD,
      files: [
        {
          path: options.candidatePath ?? 'wp-content/themes/site/header.php',
          change: 'modified',
          sizeBytes: 120,
          executable: false,
        },
      ],
      media: [],
      dbPlan,
      dbPlanSha256: planSha256,
      ...(view
        ? {
            dbView: view,
            dbViewSha256: createHash('sha256').update(JSON.stringify(view)).digest('hex'),
          }
        : {}),
      proposedBump: 'minor',
      proposedVersion: options.version ?? 'v0.1.0',
      facts: options.facts ?? {},
    },
  })
  if (options.failedCheck)
    await db.candidateCheck.create({
      data: {
        candidateId: candidate.id,
        revision: 1,
        kind: 'php_lint',
        status: 'failed',
        finishedAt: now,
      },
    })
  const version = options.version ?? 'v0.1.0'
  const release = await db.siteRelease.create({
    data: {
      siteId,
      taskId,
      candidateId: candidate.id,
      candidateRevision: 1,
      attempt: 1,
      releaseKey: createHash('sha256').update(randomUUID()).digest('hex'),
      version,
      tag: version,
      bump: 'minor',
      mainBeforeSha: INSTALLED_SHA,
      committedAt: new Date('2026-10-17T12:00:00.000Z'),
      status: 'approved',
      approvedBy: userId,
      approvedAt: now,
    },
  })
  return {
    userId,
    workspaceId: workspace.id,
    siteId,
    taskId,
    candidateId: candidate.id,
    releaseId: release.id,
    repo,
  }
}

/** What the release rows of the sites of a test leave, removed before the billing fixtures go. */
export async function cleanupReleases(db: PrismaClient, siteIds: readonly string[]): Promise<void> {
  if (siteIds.length === 0) return
  const sites = { siteId: { in: [...siteIds] } }
  const releases = await db.siteRelease.findMany({ where: sites, select: { id: true } })
  if (releases.length > 0)
    await db.outboxEvent.deleteMany({
      where: {
        OR: releases.map(({ id }) => ({ dedupeKey: { startsWith: `release.advance:${id}` } })),
      },
    })
  const plans = await db.releaseUndoPlan.findMany({ where: sites, select: { id: true } })
  if (plans.length > 0)
    await db.outboxEvent.deleteMany({
      where: {
        OR: plans.map(({ id }) => ({ dedupeKey: { startsWith: `release.undoPlan:${id}:` } })),
      },
    })
  await db.site.updateMany({
    where: { id: { in: [...siteIds] } },
    data: { installedReleaseId: null },
  })
  await db.siteLease.deleteMany({ where: sites })
  await db.siteRelease.updateMany({ where: sites, data: { deploymentId: null } })
  await db.deployment.deleteMany({ where: sites })
  // An undo names the release it undoes and its plan: it goes first.
  await db.siteRelease.deleteMany({ where: { ...sites, kind: 'undo' } })
  await db.releaseUndoPlan.deleteMany({ where: sites })
  await db.siteRelease.deleteMany({ where: sites })
  await db.siteCodeSource.deleteMany({ where: sites })
  await db.gitRepository.deleteMany({ where: sites })
  await db.credentialRef.deleteMany({ where: sites })
}
