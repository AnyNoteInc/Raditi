import { sandboxCommandFailed, type Sandbox, type TurnInboxFile } from '@repo/domain'

/** Read-only for the agent, as the plan promises: the file is the client's, not the agent's. */
const INBOX_FILE_MODE = 0o444

const failed = () => sandboxCommandFailed('Could not put the files of the client into the sandbox')

/** The whole body when it is exactly `sizeBytes` long; a longer or shorter one is refused. */
async function readExactly(file: TurnInboxFile): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.sizeBytes)
  let at = 0
  for await (const chunk of file.read()) {
    if (at + chunk.byteLength > file.sizeBytes) throw failed()
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  if (at !== file.sizeBytes) throw failed()
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
