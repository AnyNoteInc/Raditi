import { SANDBOX_WORKDIR, sandboxCommandFailed, snapshotLimits, type Sandbox } from '@repo/domain'

import { execBounded } from '@repo/snapshots'

const failed = () => sandboxCommandFailed('Could not make the working directory of the turn')

/**
 * The working directory of a turn without a repository (docs/plan/57-browser-tasks.md, Б4): an
 * empty directory — no clone, no `git init`, no commit. The runtime may already have made it;
 * links are refused before anything touches the path, as for the import of a base bundle.
 */
export async function makeEmptyWorkdir(sandbox: Sandbox): Promise<void> {
  const run = (argv: string[], maxStdout = 0) =>
    execBounded(sandbox, argv, { maxStdout, failure: failed })
  await run(['test', '!', '-L', '/workspace'])
  await run(['test', '!', '-L', SANDBOX_WORKDIR])
  await run(['mkdir', '-p', '--', SANDBOX_WORKDIR])
  const entries = await run(
    ['find', '-P', SANDBOX_WORKDIR, '-mindepth', '1', '-print', '-quit'],
    snapshotLimits.path + 1,
  )
  if (entries.stdout.byteLength > 0) throw failed()
}
