import { describe, expect, it } from 'vitest'

import {
  machineFactsFrom,
  matchRun,
  runFactsFrom,
  runServerAllowed,
  type RunFacts,
} from './run-facts.ts'

const sha = '3f786850e387550fdab836ed7e6dc881de23001b'
const releaseId = '0196abcd-0000-7000-8000-00000000000a'
/** What the workflow hands over: `gitea.*` of a push of the tag v1.4.0 (measured, plan 53). */
const pushOfTag = {
  RADITI_RUN_EVENT: 'push',
  RADITI_RUN_REF: 'refs/tags/v1.4.0',
  RADITI_RUN_REF_NAME: 'v1.4.0',
  RADITI_RUN_SHA: sha,
  RADITI_RUN_SERVER: 'https://gitea.example.test',
  RADITI_RUN_REPOSITORY: 'sites/site-0196abcd',
}
const secret = (tag: string, commit: string) =>
  `${releaseId}:2:${tag}:${commit}:hvs.CAESIAbc_def-123`

describe('the run of a deploy job', () => {
  it('is a push or a dispatch of a release tag', () => {
    expect(runFactsFrom(pushOfTag)).toEqual({
      event: 'push',
      ref: 'refs/tags/v1.4.0',
      refName: 'v1.4.0',
      sha,
      server: 'https://gitea.example.test',
      repository: 'sites/site-0196abcd',
    })
    expect(runFactsFrom({ ...pushOfTag, RADITI_RUN_EVENT: 'workflow_dispatch' })?.event).toBe(
      'workflow_dispatch',
    )
  })

  it('is not a run of the import tag, a branch, another event or a tag the ref does not name', () => {
    for (const env of [
      { ...pushOfTag, RADITI_RUN_REF: 'refs/tags/v0.0.0', RADITI_RUN_REF_NAME: 'v0.0.0' },
      { ...pushOfTag, RADITI_RUN_REF: 'refs/heads/main', RADITI_RUN_REF_NAME: 'main' },
      { ...pushOfTag, RADITI_RUN_REF_NAME: 'v1.4.1' },
      { ...pushOfTag, RADITI_RUN_EVENT: 'pull_request' },
      { ...pushOfTag, RADITI_RUN_SHA: sha.slice(1) },
      { ...pushOfTag, RADITI_RUN_REPOSITORY: 'sites/../platform' },
      { ...pushOfTag, RADITI_RUN_SERVER: 'file:///etc' },
      {},
    ])
      expect(runFactsFrom(env), JSON.stringify(env)).toBeNull()
  })
})

describe('the deploy secret against the run (Р29)', () => {
  const run = runFactsFrom(pushOfTag)!

  it('matches the secret of this tag and this commit', () => {
    const match = matchRun(secret('v1.4.0', sha), run)
    expect(match).toEqual({
      matched: true,
      wrap: { releaseId, attempt: 2, tag: 'v1.4.0', sha, wrapToken: 'hvs.CAESIAbc_def-123' },
    })
  })

  it('names why it is not for this run, and spends nothing to say so', () => {
    expect(matchRun(undefined, run)).toEqual({ matched: false, reason: 'no_secret' })
    expect(matchRun('', run)).toEqual({ matched: false, reason: 'no_secret' })
    expect(matchRun('not a wrap', run)).toEqual({ matched: false, reason: 'unreadable' })
    expect(matchRun(secret('v1.3.0', sha), run)).toEqual({
      matched: false,
      reason: 'another_run',
    })
    expect(matchRun(secret('v1.4.0', 'b'.repeat(40)), run)).toEqual({
      matched: false,
      reason: 'another_run',
    })
  })
})

describe('the machine of the deploy runner', () => {
  const machine = {
    APP_ENV: 'development',
    RADITI_VAULT_ADDR: 'http://openbao:8200',
    RADITI_RELEASE_API_URL: 'http://10.0.0.5:8085',
  }

  it('names Vault, the release API and its environment; none comes from a repository', () => {
    expect(machineFactsFrom(machine)).toEqual({
      appEnv: 'development',
      vaultAddr: 'http://openbao:8200',
      releaseApiUrl: 'http://10.0.0.5:8085',
    })
    for (const name of Object.keys(machine))
      expect(machineFactsFrom({ ...machine, [name]: undefined }), name).toBeNull()
  })

  it('reaches Vault and the Gitea of the run only over TLS in production', () => {
    expect(machineFactsFrom({ ...machine, APP_ENV: 'production' })).toBeNull()
    const production = machineFactsFrom({
      ...machine,
      APP_ENV: 'production',
      RADITI_VAULT_ADDR: 'https://vault.raditi.internal:8200',
    })!
    expect(production.appEnv).toBe('production')
    const run = runFactsFrom(pushOfTag)!
    expect(runServerAllowed(run, production)).toBe(true)
    const plain: RunFacts = { ...run, server: 'http://gitea:3000' }
    expect(runServerAllowed(plain, production)).toBe(false)
    expect(runServerAllowed(plain, machineFactsFrom(machine)!)).toBe(true)
  })
})
