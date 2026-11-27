import { describe, expect, it } from 'vitest'

import { ENV_VALUE_MASK } from '../workspace-env/env-masking.ts'
import {
  ciStagesOf,
  ciStateWord,
  maskCiLog,
  readRepoCiJobs,
  REPO_CI_LOG_BYTES,
  repoJobLogArgumentsSchema,
  repoRunsArgumentsSchema,
  tailOf,
  type RepoCiJob,
} from './ci-runs.ts'
import { ciStatusWords } from './statuses.ts'

const job = (id: string, stage: string | null, status: RepoCiJob['status']): RepoCiJob => ({
  id,
  name: `job-${id}`,
  stage,
  status,
  manual: status === 'manual',
  refusal: null,
  url: `https://gitlab.com/a/b/-/jobs/${id}`,
  startedAt: null,
  finishedAt: null,
})

describe('maskCiLog', () => {
  it('takes out the escapes of a terminal and the sections of GitLab', () => {
    const raw =
      'section_start:1731700000:prepare_script\r\x1b[0K\x1b[32;1mPreparing\x1b[0;m\n' +
      '\x1b]8;;https://x\x07link\x1b]8;;\x07 done\n' +
      'section_end:1731700001:prepare_script\r\x1b[0K\n'
    expect(maskCiLog(raw, []).text).toBe('Preparing\nlink done\n\n')
  })

  it('keeps the last state of a line a progress bar rewrote', () => {
    expect(maskCiLog('Downloading 10%\rDownloading 50%\rDownloading 100%\r\nok', []).text).toBe(
      'Downloading 100%\nok',
    )
  })

  it('masks the values of variables and the forms of keys', () => {
    const raw = [
      'export DEPLOY_PASSWORD=hunter-two-secret',
      'token glpat-ABCDEFGHIJKLMNOPQRSTUVWX used',
      'key sk-rdt-abcdefghijklmnopqrstuvwxyz123',
      'mcp mcp_0123456789abcdef0123456789abcdef',
      'gh ghp_abcdefghijklmnopqrstuvwxyzABCDEFGH1234',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\n')
    const { text } = maskCiLog(raw, ['hunter-two-secret'])
    expect(text).not.toContain('hunter-two-secret')
    expect(text).not.toContain('glpat-')
    expect(text).not.toContain('sk-rdt-')
    expect(text).not.toContain('mcp_0123')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('PRIVATE KEY')
    expect(text.split(ENV_VALUE_MASK)).toHaveLength(7)
  })

  it('keeps a tail of 64 KiB from the start of a line', () => {
    const line = 'x'.repeat(99) + '\n'
    const raw = `${line.repeat(1000)}last line`
    const { text, truncated } = maskCiLog(raw, [])
    expect(truncated).toBe(true)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(REPO_CI_LOG_BYTES)
    expect(text.startsWith('x')).toBe(true)
    expect(text.endsWith('last line')).toBe(true)
  })

  it('never cuts a character in two', () => {
    const { text } = tailOf('ж'.repeat(10), 5)
    expect(text).toBe('жж')
  })
})

describe('the runs', () => {
  it('groups jobs by stage in the order of the configuration', () => {
    const stages = ciStagesOf([
      job('13', 'deploy', 'manual'),
      job('12', 'test', 'failed'),
      job('11', 'test', 'success'),
      job('10', 'lint', 'success'),
    ])
    expect(stages.map((s) => [s.name, s.status, s.jobs.length])).toEqual([
      ['lint', 'success', 1],
      ['test', 'failed', 2],
      ['deploy', 'manual', 1],
    ])
  })

  it('reads only kept jobs', () => {
    expect(readRepoCiJobs([job('1', null, 'running')])).toHaveLength(1)
    expect(readRepoCiJobs([{ id: 'x' }])).toEqual([])
    expect(readRepoCiJobs(null)).toEqual([])
  })

  it('says statuses in the words of ПР17 and a refusal in its own', () => {
    expect(ciStatusWords.failed).toBe('Упала')
    expect(ciStatusWords.pending).toBe('Ждёт запуска')
    expect(ciStatusWords.manual).toBe('Ждёт ручного запуска')
    expect(ciStateWord('failed', null, ciStatusWords)).toBe('Упала')
    expect(ciStateWord('failed', 'account_unverified', ciStatusWords)).toContain(
      'подтвердить учётную запись',
    )
  })

  it('checks the arguments of the tools', () => {
    expect(repoRunsArgumentsSchema.safeParse({ limit: 11 }).success).toBe(false)
    expect(repoRunsArgumentsSchema.safeParse({ branch: 'chat', limit: 3 }).success).toBe(true)
    expect(repoJobLogArgumentsSchema.safeParse({ runId: '1', jobId: '2' }).success).toBe(true)
    expect(
      repoJobLogArgumentsSchema.safeParse({ runId: '1', jobId: '2', tailBytes: 99 }).success,
    ).toBe(false)
  })
})
