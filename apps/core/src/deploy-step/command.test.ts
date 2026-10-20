import { describe, expect, it, vi } from 'vitest'

import { deployStepCommand, type DeployStepIo } from './command.ts'

const sha = '3f786850e387550fdab836ed7e6dc881de23001b'
const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const wrapToken = 'hvs.CAESIAbc_def-123'
const backupKey = Buffer.alloc(32, 7).toString('base64')

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  APP_ENV: 'development',
  RADITI_VAULT_ADDR: 'http://openbao:8200',
  RADITI_RELEASE_API_URL: 'http://core:8085',
  RADITI_RUN_EVENT: 'push',
  RADITI_RUN_REF: 'refs/tags/v1.4.0',
  RADITI_RUN_REF_NAME: 'v1.4.0',
  RADITI_RUN_SHA: sha,
  RADITI_RUN_SERVER: 'https://gitea.example.test',
  RADITI_RUN_REPOSITORY: 'sites/demo',
  RADITI_DEPLOY_WRAP: `${releaseId}:2:v1.4.0:${sha}:${wrapToken}`,
  RADITI_JOB_TOKEN: 'job-token-of-the-run',
  ...overrides,
})

const wrapped = (overrides: Record<string, string> = {}) => ({
  v: '1',
  releaseId,
  attempt: '2',
  releaseApiToken: 'A'.repeat(43),
  backupKey,
  ...overrides,
})

function io(
  env: Record<string, string | undefined>,
  unwrap: DeployStepIo['unwrap'] = async () => wrapped(),
) {
  const lines: string[] = []
  const outputs: Record<string, string> = {}
  const deploy = vi.fn<DeployStepIo['deploy']>(async () => ({
    outcome: 'installed' as const,
    told: true,
  }))
  const unwrapSpy = vi.fn<DeployStepIo['unwrap']>(unwrap)
  const reachable = vi.fn<DeployStepIo['reachable']>(async () => true)
  return {
    lines,
    outputs,
    deploy,
    unwrap: unwrapSpy,
    reachable,
    io: {
      env,
      print: (line: string) => lines.push(line),
      setOutput: (name: string, value: string) => {
        outputs[name] = value
      },
      reachable,
      unwrap: unwrapSpy,
      deploy,
    } satisfies DeployStepIo,
  }
}

describe('deploy-step match', () => {
  it('says whether the secret is for this run and reaches nothing', async () => {
    const env = environment()
    const t = io(env)
    expect(await deployStepCommand(['match'], t.io)).toBe(0)
    expect(t.outputs).toEqual({ matched: 'true' })
    expect(t.lines).toEqual([
      `deploy-step: run event=push ref=refs/tags/v1.4.0 ref_name=v1.4.0 sha=${sha}`,
      'deploy-step: the deploy secret is for this run',
    ])
    expect(t.unwrap).not.toHaveBeenCalled()
    expect(env.RADITI_DEPLOY_WRAP).toBeUndefined()
  })

  it('answers false for another tag and for a repository without the secret', async () => {
    for (const env of [
      environment({ RADITI_DEPLOY_WRAP: `${releaseId}:2:v1.3.0:${sha}:${wrapToken}` }),
      environment({ RADITI_DEPLOY_WRAP: '' }),
      environment({ RADITI_RUN_REF: 'refs/tags/v0.0.0', RADITI_RUN_REF_NAME: 'v0.0.0' }),
    ]) {
      const t = io(env)
      expect(await deployStepCommand(['match'], t.io)).toBe(0)
      expect(t.outputs).toEqual({ matched: 'false' })
    }
  })

  it('prints no secret, ever', async () => {
    const matching = io(environment())
    await deployStepCommand(['match'], matching.io)
    const running = io(environment())
    await deployStepCommand(['run'], running.io)
    for (const { lines } of [matching, running]) {
      expect(lines.join('\n')).not.toContain(wrapToken)
      expect(lines.join('\n')).not.toContain('job-token-of-the-run')
    }
  })
})

describe('deploy-step run (Р29)', () => {
  it('compares the secret with the run before it unwraps, then deploys once', async () => {
    const env = environment()
    const t = io(env)
    expect(await deployStepCommand(['run'], t.io)).toBe(0)
    expect(t.reachable).toHaveBeenCalledWith('http://core:8085')
    expect(t.unwrap).toHaveBeenCalledOnce()
    expect(t.unwrap).toHaveBeenCalledWith('http://openbao:8200', wrapToken)
    expect(t.reachable.mock.invocationCallOrder[0]).toBeLessThan(
      t.unwrap.mock.invocationCallOrder[0]!,
    )
    expect(t.deploy).toHaveBeenCalledOnce()
    const input = t.deploy.mock.calls[0]![0]
    expect(input.wrap).toEqual({ releaseId, attempt: 2, tag: 'v1.4.0', sha, wrapToken })
    expect(input.jobToken).toBe('job-token-of-the-run')
    expect(input.data.releaseApiToken).toBe('A'.repeat(43))
    expect(input.machine.releaseApiUrl).toBe('http://core:8085')
    // Nothing the command starts sees the secrets.
    expect(env.RADITI_DEPLOY_WRAP).toBeUndefined()
    expect(env.RADITI_JOB_TOKEN).toBeUndefined()
    expect(t.lines.at(-1)).toBe('deploy-step: the release is installed')
  })

  it('spends nothing for a tag of the import, another tag or another commit', async () => {
    for (const env of [
      environment({ RADITI_DEPLOY_WRAP: `${releaseId}:2:v1.3.0:${sha}:${wrapToken}` }),
      environment({ RADITI_DEPLOY_WRAP: `${releaseId}:2:v1.4.0:${'b'.repeat(40)}:${wrapToken}` }),
      environment({ RADITI_DEPLOY_WRAP: undefined }),
      environment({ RADITI_DEPLOY_WRAP: 'garbage' }),
      environment({ RADITI_RUN_REF: 'refs/tags/v0.0.0', RADITI_RUN_REF_NAME: 'v0.0.0' }),
    ]) {
      const t = io(env)
      expect(await deployStepCommand(['run'], t.io)).toBe(0)
      expect(t.unwrap).not.toHaveBeenCalled()
      expect(t.deploy).not.toHaveBeenCalled()
      expect(env.RADITI_DEPLOY_WRAP).toBeUndefined()
    }
  })

  it('fails without unwrapping on a runner that is not configured for releases', async () => {
    for (const env of [
      environment({ RADITI_VAULT_ADDR: undefined }),
      environment({ RADITI_RELEASE_API_URL: undefined }),
      environment({ RADITI_JOB_TOKEN: undefined }),
      environment({ APP_ENV: 'production', RADITI_VAULT_ADDR: 'http://openbao:8200' }),
    ]) {
      const t = io(env)
      expect(await deployStepCommand(['run'], t.io)).toBe(1)
      expect(t.unwrap).not.toHaveBeenCalled()
      expect(t.lines.at(-1)).toBe(
        'deploy-step: the runner is not configured for releases — nothing was unwrapped',
      )
    }
  })

  it('does not spend the wrapping while the release API does not answer', async () => {
    const t = io(environment())
    t.reachable.mockResolvedValueOnce(false)
    expect(await deployStepCommand(['run'], t.io)).toBe(1)
    expect(t.unwrap).not.toHaveBeenCalled()
    expect(t.deploy).not.toHaveBeenCalled()
    expect(t.lines.at(-1)).toBe(
      'deploy-step: the release API did not answer — nothing was unwrapped',
    )
  })

  it('stops at a spent, expired or foreign wrapping', async () => {
    for (const unwrap of [
      async () => null,
      async () => wrapped({ attempt: '3' }),
      async () => wrapped({ releaseId: '0196abcd-0000-7000-8000-00000000000b' }),
      async () => ({ v: '1', token: 'x' }),
    ]) {
      const t = io(environment(), unwrap)
      expect(await deployStepCommand(['run'], t.io)).toBe(1)
      expect(t.deploy).not.toHaveBeenCalled()
      expect(t.lines.at(-1)).toBe(
        'deploy-step: the deploy secret was already used, has expired or holds something else',
      )
    }
    const t = io(environment(), async () => {
      throw new Error('ECONNREFUSED openbao:8200')
    })
    expect(await deployStepCommand(['run'], t.io)).toBe(1)
    expect(t.lines.at(-1)).toBe('deploy-step: Vault did not answer — nothing was unwrapped')
  })

  it('ends 1 unless the release is installed, with a fixed line for each outcome', async () => {
    for (const [outcome, line] of [
      ['rolled_back', 'the release was rolled back: the site is as it was'],
      ['failed', 'the release was not installed: nothing was written'],
      ['unknown', 'what the site holds could not be proved: the operator decides'],
    ] as const) {
      const t = io(environment())
      t.deploy.mockResolvedValueOnce({ outcome, told: true })
      expect(await deployStepCommand(['run'], t.io)).toBe(1)
      expect(t.lines.at(-1)).toBe(`deploy-step: ${line}`)
    }
    // Installed, but core never took the end: it would take the job for a silent one.
    const untold = io(environment())
    untold.deploy.mockResolvedValueOnce({ outcome: 'installed', told: false })
    expect(await deployStepCommand(['run'], untold.io)).toBe(1)
    expect(untold.lines.slice(-2)).toEqual([
      'deploy-step: the release is installed',
      'deploy-step: core did not take the end of the deploy',
    ])
    const t = io(environment())
    t.deploy.mockRejectedValueOnce(new Error('The release API refused (409)'))
    expect(await deployStepCommand(['run'], t.io)).toBe(1)
    expect(t.lines.at(-1)).toBe(
      'deploy-step: the release API did not give this attempt its manifest — nothing was written',
    )
  })

  it('knows two commands only', async () => {
    for (const args of [[], ['deploy'], ['run', 'extra'], ['constructor'], ['__proto__']]) {
      const t = io(environment())
      expect(await deployStepCommand(args, t.io)).toBe(2)
      expect(t.unwrap).not.toHaveBeenCalled()
    }
  })
})
