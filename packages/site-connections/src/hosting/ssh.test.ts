import { Socket } from 'node:net'

import { resolvePinnedAddress, sshAccessSchema } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { startTestSftpServer, type TestSftpServer } from '../testing/index.ts'
import { connectSftp } from './ssh.ts'

let server: TestSftpServer

beforeAll(async () => {
  server = await startTestSftpServer({
    files: { 'public_html/index.php': '<?php' },
    home: '/',
    users: [{ username: 'site', password: 'p@ss word' }],
  })
})

afterAll(async () => {
  await server.close()
})

describe('connectSftp of a release', () => {
  it('sends each request at once: no Nagle wait on a request of the session (Э3.16)', async () => {
    // Without TCP_NODELAY a request written in two parts waits for the ACK the server delays: on a
    // Linux host a small file took 2.7 s instead of 1 ms (docs/plan/62-site-stacks.md, §10, Э3.16).
    const pinned = await resolvePinnedAddress(
      { appEnv: 'development', lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      '127.0.0.1',
      new AbortController().signal,
    )
    if (!pinned.ok) throw new Error('cannot pin 127.0.0.1')
    const access = sshAccessSchema.parse({
      v: '1',
      host: '127.0.0.1',
      port: String(server.port),
      hostKey: server.hostKey,
      rootPath: 'public_html',
      username: 'site',
      auth: 'password',
      password: 'p@ss word',
    })
    // On the socket itself: ssh2's Client.setNoDelay does nothing before connect() made its
    // socket, so a spy on the client would pass a call that never reached TCP.
    const noDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
    try {
      const connection = await connectSftp(
        access,
        pinned.address,
        AbortSignal.timeout(10_000),
        10_000,
      )
      try {
        const socket = (connection.client as unknown as { _sock?: unknown })._sock
        expect(socket).toBeInstanceOf(Socket)
        const call = noDelay.mock.contexts.indexOf(socket as Socket)
        expect(call).toBeGreaterThanOrEqual(0)
        expect(noDelay.mock.calls[call]).toEqual([true])
      } finally {
        connection.close()
      }
    } finally {
      noDelay.mockRestore()
    }
  })
})
