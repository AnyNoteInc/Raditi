import { randomBytes, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { moveChatToProject } from './projects.ts'
import {
  chatBranchHead,
  ensureChatBranch,
  closeStaleRepoProposals,
  failRepoTurn,
  pendingRepoProposals,
  reserveRepoProposal,
} from './repo-work.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const image = `registry.example.test/sandbox@sha256:${'a'.repeat(64)}`

async function refusal(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return String((error as Error).message)
  }
}

/** Two UUIDs of version 7 made in the same millisecond: their first characters are the same. */
function sameMinuteIds(): [string, string] {
  const time = Date.now().toString(16).padStart(12, '0')
  const one = () => {
    const random = randomBytes(10).toString('hex')
    const hex = `${time}7${random.slice(0, 3)}8${random.slice(3, 18)}`
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return [one(), one()]
}

// The work of a chat in the repository of its project (docs/plan/84-projects.md, ПР13, ПР14, ПР25;
// slice 84.19): the migration 20261117150000_project_repo_work on a schema of its own.
describe.skipIf(!databaseUrl)(
  'PostgreSQL: branches and proposals of a repository (plan 84)',
  () => {
    let schema: MigratedSchema
    let db: PrismaClient

    beforeAll(async () => {
      schema = await createMigratedSchema(databaseUrl ?? '', 'repo_work')
      await schema.migrate()
      db = schemaClient(databaseUrl ?? '', schema)
      await db.agentDriver.upsert({
        where: { id: 'opencode' },
        update: {},
        create: { id: 'opencode', image, capabilities: {}, enabled: true },
      })
    }, 60_000)
    afterAll(async () => {
      await db?.$disconnect()
      await schema?.drop()
    })

    async function owner() {
      const user = await db.user.create({
        data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
      })
      const workspace = await db.workspace.create({
        data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
      })
      const project = await db.project.create({
        data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, name: 'Колос' },
      })
      const repository = await db.projectRepository.create({
        data: {
          id: randomUUID(),
          projectId: project.id,
          workspaceId: workspace.id,
          provider: 'github',
          host: 'github.com',
          path: 'kolos/site',
          webUrl: 'https://github.com/kolos/site',
          defaultBranch: 'main',
          mode: 'read',
        },
      })
      return { userId: user.id, workspaceId: workspace.id, projectId: project.id, repository }
    }

    const chat = (workspaceId: string, projectId: string, id = uuidv7()) =>
      db.task.create({
        data: { id, workspaceId, projectId, status: 'awaiting_user', title: 'Новое меню' },
        select: { id: true, workspaceId: true, status: true },
      })

    it('names the branches of two chats of one minute apart, and suffixes a name in use', async () => {
      const own = await owner()
      const [a, b] = sameMinuteIds()
      expect(a.slice(0, 13)).toBe(b.slice(0, 13))
      await chat(own.workspaceId, own.projectId, a)
      await chat(own.workspaceId, own.projectId, b)
      const base = {
        projectRepositoryId: own.repository.id,
        title: 'Новое меню',
        baseSha: 'a'.repeat(40),
      }
      const one = await ensureChatBranch(db, { ...base, taskId: a })
      const two = await ensureChatBranch(db, { ...base, taskId: b })
      expect(one.branch).toMatch(/^raditi\/novoe-menyu-[0-9a-f]{8}$/)
      expect(two.branch).not.toBe(one.branch)
      // Again: the chat's own row, by its id.
      expect(await ensureChatBranch(db, { ...base, taskId: a })).toEqual(one)
      // Another chat whose id ends the same takes the next free name.
      const c = `${uuidv7().slice(0, 28)}${a.slice(-8)}`
      await chat(own.workspaceId, own.projectId, c)
      expect((await ensureChatBranch(db, { ...base, taskId: c })).branch).toBe(`${one.branch}-2`)
    })

    it('refuses a branch outside raditi/, an unknown state and a half-sent branch', async () => {
      const own = await owner()
      const task = await chat(own.workspaceId, own.projectId)
      const row = (fields: Record<string, unknown>) =>
        db.projectRepoBranch.create({
          data: {
            taskId: task.id,
            projectRepositoryId: own.repository.id,
            branch: 'raditi/x-00000000',
            baseSha: 'a'.repeat(40),
            ...fields,
          },
        })
      expect(await refusal(() => row({ branch: 'main' }))).toMatch(
        /project_repo_branches_branch_check/,
      )
      expect(await refusal(() => row({ state: 'gone' }))).toMatch(
        /project_repo_branches_state_check/,
      )
      expect(await refusal(() => row({ mirrorSha: 'b'.repeat(40) }))).toMatch(
        /project_repo_branches_pushed_check/,
      )
      expect(await refusal(() => row({ baseSha: 'X'.repeat(40) }))).toMatch(
        /project_repo_branches_sha_check/,
      )
    })

    it('keeps one row of repo_actions per token, with a kind and a state it knows', async () => {
      const own = await owner()
      const action = (fields: Record<string, unknown> = {}) =>
        db.repoAction.create({
          data: {
            id: randomUUID(),
            projectRepositoryId: own.repository.id,
            createdById: own.userId,
            kind: 'push',
            args: { token: 'x', mergeRequest: null },
            tokenSha256: 'c'.repeat(64),
            ...fields,
          },
        })
      await action()
      expect(await refusal(() => action())).toMatch(/token_sha256/)
      expect(await refusal(() => action({ tokenSha256: 'd'.repeat(64), kind: 'tag' }))).toMatch(
        /repo_actions_kind_check/,
      )
      expect(await refusal(() => action({ tokenSha256: 'e'.repeat(64), state: 'done' }))).toMatch(
        /repo_actions_finished_check/,
      )
    })

    it('takes one proposal of a merge request a turn, and a failed pass closes it', async () => {
      const own = await owner()
      const task = await chat(own.workspaceId, own.projectId)
      const proposal = { title: 'Зимнее меню', description: 'Цены', draft: false }
      const input = { workspaceId: own.workspaceId, taskId: task.id, turnNo: 1, proposal }
      const { reservationId } = await reserveRepoProposal(db, input)
      await expect(reserveRepoProposal(db, input)).rejects.toMatchObject({
        code: 'REPO_PROPOSAL_LIMIT',
      })
      expect(await pendingRepoProposals(db, task.id, 1)).toEqual([
        { id: reservationId, payload: proposal },
      ])
      expect(await failRepoTurn(db, task.id, 1)).toBe(1)
      expect(await pendingRepoProposals(db, task.id, 1)).toEqual([])
    })

    it('closes a proposal of a lost pass a day on, never one of a turn still assigned (ревью C11)', async () => {
      const own = await owner()
      const lost = await chat(own.workspaceId, own.projectId)
      const live = await chat(own.workspaceId, own.projectId)
      const proposal = { title: 'Меню', description: '', draft: false }
      for (const task of [lost, live])
        await reserveRepoProposal(db, {
          workspaceId: own.workspaceId,
          taskId: task.id,
          turnNo: 1,
          proposal,
        })
      await db.turnAssignment.create({
        data: {
          taskId: live.id,
          siteId: live.id,
          sessionId: live.id,
          turnNo: 1,
          executor: 'local',
          plan: {},
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 60_000),
        },
      })
      expect(await closeStaleRepoProposals(db, new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(
        1,
      )
      expect(await pendingRepoProposals(db, lost.id, 1)).toEqual([])
      expect(await pendingRepoProposals(db, live.id, 1)).toHaveLength(1)
      await db.turnAssignment.deleteMany({ where: { taskId: live.id } })
    })

    it('reads the head of the branch past the turns /undo took back (ПР25)', async () => {
      const own = await owner()
      const task = await chat(own.workspaceId, own.projectId)
      const turn = (turnNo: number, headSha: string | null, fields: Record<string, unknown> = {}) =>
        db.taskTurn.create({
          data: {
            taskId: task.id,
            turnNo,
            status: 'completed',
            driverId: 'opencode',
            image,
            headSha,
            baseSha: 'a'.repeat(40),
            ...fields,
          },
        })
      expect(await chatBranchHead(db, task.id)).toBeNull()
      await turn(1, 'b'.repeat(40))
      await turn(2, null)
      await turn(3, 'c'.repeat(40), { undoneAt: new Date() })
      await turn(4, 'd'.repeat(40), { rejectedAt: new Date() })
      expect(await chatBranchHead(db, task.id)).toMatchObject({
        turnNo: 1,
        headSha: 'b'.repeat(40),
      })
      await db.taskTurn.updateMany({
        where: { taskId: task.id, turnNo: 3 },
        data: { undoneAt: null },
      })
      expect(await chatBranchHead(db, task.id)).toMatchObject({
        turnNo: 3,
        headSha: 'c'.repeat(40),
      })
    })

    it('does not move a chat with a branch to another project (TASK_PROJECT_HAS_BRANCH)', async () => {
      const own = await owner()
      const task = await chat(own.workspaceId, own.projectId)
      await ensureChatBranch(db, {
        taskId: task.id,
        projectRepositoryId: own.repository.id,
        title: null,
        baseSha: 'a'.repeat(40),
      })
      await expect(
        db.$transaction((tx) =>
          moveChatToProject(tx, { task, projectId: null, userId: own.userId, now: new Date() }),
        ),
      ).rejects.toMatchObject({ code: 'TASK_PROJECT_HAS_BRANCH' })
    })
  },
)
