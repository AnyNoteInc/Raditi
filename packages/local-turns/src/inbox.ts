import {
  sandboxCommandFailed,
  turnSkillFileMode,
  type Sandbox,
  type TurnInboxFile,
  type TurnSkillFile,
} from '@repo/domain'

/** Read-only for the agent, as the plan promises: the file is the client's, not the agent's. */
const INBOX_FILE_MODE = 0o444

const failed = () => sandboxCommandFailed('Could not put the files of the client into the sandbox')
const failedProject = () =>
  sandboxCommandFailed('Could not put the files of the project into the sandbox')
const failedSkills = () =>
  sandboxCommandFailed('Could not put the skills of the account into the sandbox')

/** The whole body when it is exactly `sizeBytes` long; a longer or shorter one is refused. */
async function readExactly(
  file: Pick<TurnInboxFile, 'sizeBytes' | 'read'>,
  refuse = failed,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.sizeBytes)
  let at = 0
  for await (const chunk of file.read()) {
    if (at + chunk.byteLength > file.sizeBytes) throw refuse()
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  if (at !== file.sizeBytes) throw refuse()
  return bytes
}

/**
 * The files the client sent with the task, each at its path under SANDBOX_INBOX (spec §8,
 * «Подготовка»): one at a time, so a turn holds at most one of them in memory. The sandbox's own
 * file helper makes the folders and follows no link on the way.
 */
export async function placeInbox(
  sandbox: Pick<Sandbox, 'fs'>,
  files: readonly TurnInboxFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    signal?.throwIfAborted()
    await sandbox.fs.write(file.path, await readExactly(file), { mode: INBOX_FILE_MODE })
  }
}

/**
 * The files of the context of the chat's project, each at its path under SANDBOX_PROJECT
 * (docs/plan/84-projects.md, ПР8), after the files of the client: one at a time, read-only, the
 * folders of a path made by the sandbox's own helper, which follows no link on the way. Every turn
 * puts them again from raditi-inbox; nothing under SANDBOX_PROJECT is captured, so what the agent
 * changes there is not kept.
 */
export async function placeProjectFiles(
  sandbox: Pick<Sandbox, 'fs'>,
  files: readonly TurnInboxFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    signal?.throwIfAborted()
    await sandbox.fs.write(file.path, await readExactly(file, failedProject), {
      mode: INBOX_FILE_MODE,
    })
  }
}

/**
 * The files of the skills of the account of the turn, each at its path under SANDBOX_SKILLS
 * (docs/plan/97-skills.md, Нв13), after the files of the project: one at a time, read-only — a
 * program also executable —, the folders made by the sandbox's own helper. Every turn puts them
 * again from raditi-inbox; nothing under SANDBOX_SKILLS is captured.
 */
export async function placeSkillFiles(
  sandbox: Pick<Sandbox, 'fs'>,
  files: readonly TurnSkillFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    signal?.throwIfAborted()
    // An empty file of a skill (`__init__.py`) is a file too: nothing to read.
    const bytes = file.sizeBytes === 0 ? new Uint8Array() : await readExactly(file, failedSkills)
    await sandbox.fs.write(file.path, bytes, { mode: turnSkillFileMode(file.executable) })
  }
}
