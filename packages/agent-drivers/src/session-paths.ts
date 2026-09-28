import { createHash } from 'node:crypto'

import { badRequest, SANDBOX_WORKDIR, type PreparedRun } from '@repo/domain'

import { nativeSessionId } from './jsonl.ts'

/** Called after the turn: started.nativeSessionId must already be copied into the run context. */
export function requireNativeSessionId(run: PreparedRun): string {
  const id = nativeSessionId(run.context.nativeSessionId)
  if (!id) throw badRequest('A valid native session id is required to snapshot this driver')
  return id
}

// Kimi 2.1 encodeWorkDirKey; /workspace/repo is fixed by the domain contract.
export const KIMI_WORKDIR_KEY = `wd_repo_${createHash('sha256').update(SANDBOX_WORKDIR).digest('hex').slice(0, 12)}`
// Qwen 0.24 sanitizeCwd on Linux; never derive it from the developer's host working directory.
export const QWEN_PROJECT_KEY = SANDBOX_WORKDIR.replace(/[^a-zA-Z0-9]/g, '-')
