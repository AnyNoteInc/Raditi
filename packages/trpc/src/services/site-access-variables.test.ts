import type { PrismaClient } from '@repo/db'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { fakeSecretStore, vaultUnavailable } from '../testing/site-connections.ts'
import {
  accessVariablesOf,
  recordAccessVariables,
  replaceAccessVariables,
  replacedVariableNames,
} from './site-access-variables.ts'

// The accesses of a site as its variables (owner's decision of 26.10.2026): which fields become
// which variables, the rows of a site being created, and the replacement after «Изменить доступ».

const siteId = '0196abcd-0000-8000-8000-0000000000aa'
const userId = '0196abcd-0000-8000-8000-0000000000bb'
const now = new Date('2026-10-26T10:00:00Z')
const sftp = {
  accessKind: 'ssh' as const,
  secret: {
    v: '1',
    host: 'files.example.ru',
    port: '22',
    hostKey: 'ssh-ed25519 SHA256:x',
    rootPath: '/var/www/site',
    username: 'site-user-1',
    auth: 'password',
    password: 'site-password-1',
  },
  target: {},
}

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

function fakeTx(existing: string[] = []) {
  return {
    siteEnvVar: {
      findMany: vi.fn().mockResolvedValue(existing.map((name) => ({ name }))),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  }
}

describe('the accesses of a site as its variables', () => {
  it('leaves out a value the site address holds, by its host as typed and as punycode', () => {
    const ftp = {
      accessKind: 'ftp' as const,
      secret: { host: 'xn--e1aiboc0b6e.xn--p1ai', port: '21', username: 'u', password: 'pw-1' },
      target: {},
    }
    expect(accessVariablesOf('https://xn--e1aiboc0b6e.xn--p1ai', [ftp, null])).toEqual([
      { name: 'FTP_PORT', value: '21' },
      { name: 'FTP_USER', value: 'u' },
      { name: 'FTP_PASSWORD', value: 'pw-1' },
    ])
  })

  it('creates the rows it has room for and gives a row that is there only the later version', async () => {
    const tx = fakeTx(['SFTP_HOST'])
    await recordAccessVariables(tx as never, {
      siteId,
      userId,
      dataClass: 'synthetic',
      written: [
        { name: 'SFTP_HOST', version: 3 },
        { name: 'SFTP_USER', version: 1 },
      ],
      now,
    })
    expect(tx.siteEnvVar.createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ name: 'SFTP_USER', toAgent: true, agentConsentAt: now, hosts: [] }),
    ])
    // What the client set in «Переменные» stays: only the version moves, and never back.
    expect(tx.siteEnvVar.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { siteId, name: 'SFTP_HOST', keyVersion: { lt: 3 } },
      data: { keyVersion: 3 },
    })
  })

  it('names the variables of the kind the site no longer has, and of the fields the new access lacks', () => {
    const sftpByPassword = ['SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_PASSWORD']
    expect(replacedVariableNames('ftp', 'ssh', sftpByPassword)).toEqual([
      'FTP_HOST',
      'FTP_PORT',
      'FTP_USER',
      'FTP_PASSWORD',
      'SFTP_PRIVATE_KEY',
      'SFTP_PASSPHRASE',
    ])
    // A password replaced by a key without a phrase: the old password does not stay a variable.
    expect(
      replacedVariableNames('ssh', 'ssh', [
        'SFTP_HOST',
        'SFTP_PORT',
        'SFTP_USER',
        'SFTP_PRIVATE_KEY',
      ]),
    ).toEqual(['SFTP_PASSWORD', 'SFTP_PASSPHRASE'])
    expect(
      replacedVariableNames(null, 'ftp', ['FTP_HOST', 'FTP_PORT', 'FTP_USER', 'FTP_PASSWORD']),
    ).toEqual([])
  })
})

describe('replaceAccessVariables', () => {
  function setup(
    site: { deleted: boolean; data_class: string } | null,
    candidates: { id: string; dbView: unknown }[] = [],
  ) {
    const secrets = fakeSecretStore()
    const tx = {
      ...fakeTx(),
      $queryRaw: vi.fn().mockResolvedValue(site ? [site] : []),
      credentialRef: { findUnique: vi.fn().mockResolvedValue({ keyVersion: 2 }) },
      taskCandidate: {
        findMany: vi.fn().mockResolvedValue(candidates),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const db = { $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) }
    return { secrets, tx, db: db as unknown as PrismaClient }
  }

  it('writes the new variables, removes the rows of the old kind and erases their values', async () => {
    const { secrets, tx, db } = setup({ deleted: false, data_class: 'client' })
    secrets.preset(`kv/sites/${siteId}/env/FTP_PASSWORD`, 1)

    await replaceAccessVariables(db, secrets, {
      siteId,
      userId,
      siteUrl: 'https://example.ru',
      prepared: sftp,
      previousAccessKind: 'ftp',
      now,
    })

    expect(secrets.writes.map(({ path }) => path.split('/').at(-1))).toEqual([
      'SFTP_HOST',
      'SFTP_PORT',
      'SFTP_USER',
      'SFTP_PASSWORD',
      // Only a key that holds a value gets a version without one.
      'FTP_PASSWORD',
    ])
    expect(secrets.writes.at(-1)!.data).toEqual({ removed: now.toISOString() })
    // A workspace of real client data: nothing reaches the agent.
    expect(tx.siteEnvVar.createMany.mock.calls[0]![0].data).toEqual(
      expect.arrayContaining([expect.objectContaining({ toAgent: false, agentConsentAt: null })]),
    )
    expect(tx.siteEnvVar.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        siteId,
        name: {
          in: [
            'FTP_HOST',
            'FTP_PORT',
            'FTP_USER',
            'FTP_PASSWORD',
            'SFTP_PRIVATE_KEY',
            'SFTP_PASSPHRASE',
          ],
        },
      },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes under the lock of the site only while the reference still names the version of this change', async () => {
    const { secrets, tx, db } = setup({ deleted: false, data_class: 'synthetic' })
    const change = {
      siteId,
      userId,
      siteUrl: 'https://example.ru',
      prepared: sftp,
      previousAccessKind: 'ssh',
      now,
    }
    // A later change of the same access committed meanwhile: its variables are the ones to stay.
    await replaceAccessVariables(db, secrets, {
      ...change,
      reference: { vaultPath: `kv/sites/${siteId}/ssh`, version: 1 },
    })
    expect(tx.credentialRef.findUnique).toHaveBeenCalledWith({
      where: { vaultPath: `kv/sites/${siteId}/ssh` },
      select: { keyVersion: true },
    })
    expect(secrets.writes).toEqual([])
    expect(tx.siteEnvVar.createMany).not.toHaveBeenCalled()

    await replaceAccessVariables(db, secrets, {
      ...change,
      reference: { vaultPath: `kv/sites/${siteId}/ssh`, version: 2 },
    })
    expect(secrets.writes.map(({ path }) => path.split('/').at(-1))).toEqual([
      'SFTP_HOST',
      'SFTP_PORT',
      'SFTP_USER',
      'SFTP_PASSWORD',
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes back a description of a database plan that holds a new value', async () => {
    const view = (after: string) => ({
      v: 1,
      planSha256: '0'.repeat(64),
      operations: [
        {
          kind: 'option_update',
          index: 0,
          objectRef: 'option:delivery_password',
          label: 'Пароль доставки',
          before: 'старый',
          after,
          truncated: false,
        },
      ],
      truncated: false,
      oversize: false,
    })
    const { secrets, tx, db } = setup({ deleted: false, data_class: 'synthetic' }, [
      { id: 'holds', dbView: view('site-password-1') },
      { id: 'clean', dbView: view('другой текст') },
    ])
    await replaceAccessVariables(db, secrets, {
      siteId,
      userId,
      siteUrl: 'https://example.ru',
      prepared: sftp,
      previousAccessKind: 'ssh',
      now,
    })
    expect(tx.taskCandidate.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ['holds'] } },
      data: { dbView: expect.anything(), dbViewSha256: null },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes nothing for a site deleted meanwhile: no value outlives its erased secrets', async () => {
    const { secrets, tx, db } = setup({ deleted: true, data_class: 'synthetic' })
    await replaceAccessVariables(db, secrets, {
      siteId,
      userId,
      siteUrl: 'https://example.ru',
      prepared: sftp,
      previousAccessKind: null,
      now,
    })
    expect(secrets.writes).toEqual([])
    expect(tx.siteEnvVar.createMany).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs a Vault that fails and lets the replaced access stand, never saying what it said', async () => {
    const { secrets, tx, db } = setup({ deleted: false, data_class: 'synthetic' })
    secrets.failure = vaultUnavailable()
    await expect(
      replaceAccessVariables(db, secrets, {
        siteId,
        userId,
        siteUrl: 'https://example.ru',
        prepared: sftp,
        previousAccessKind: 'ssh',
        now,
      }),
    ).resolves.toBeUndefined()
    expect(tx.siteEnvVar.createMany).not.toHaveBeenCalled()
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain(`site_access_variables_failed site=${siteId}`)
    expect(logged).not.toContain('ECONNREFUSED')
  })
})
