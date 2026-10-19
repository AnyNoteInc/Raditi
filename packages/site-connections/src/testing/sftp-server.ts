import type { AddressInfo } from 'node:net'

import type { Attributes, AuthContext, Connection, FileEntry, ParsedKey, SFTPWrapper } from 'ssh2'
import ssh2 from 'ssh2'

import { generateTestSshKey, sshFingerprintOf } from './ssh-keys.ts'
import { normalizePath, TestTree, type TreeNode } from './tree.ts'

// An SSH server on loopback that speaks only SFTP over an in-memory, read-only tree: what the SFTP
// adapter is tested against. It records every authentication request (so a test can prove that a
// check without a host key logs in nowhere) and every request that would change the tree.

const { Server, utils } = ssh2
const STATUS = utils.sftp.STATUS_CODE
const MODE = utils.sftp.OPEN_MODE
const WRITE_FLAGS = MODE.WRITE | MODE.APPEND | MODE.CREAT | MODE.TRUNC

export interface TestSftpUser {
  username: string
  password?: string
  /** One `authorized_keys` line. */
  publicKey?: string
}

export interface TestSftpServerOptions {
  /** Path → content; relative paths start at `/`. Parent folders are created. */
  files: Record<string, string | Uint8Array>
  directories?: string[]
  users: TestSftpUser[]
  /** The host key (OpenSSH or PEM private key); a fresh ed25519 key by default. */
  hostKeyPem?: string
  /** Path → target: symbolic links of the tree. */
  links?: Record<string, string>
  /** List a link as what it points to — the server that makes a linked folder look like a folder. */
  listLinksAsTargets?: boolean
  /** Where a relative path starts: the login folder. `/` by default. */
  home?: string
  /** Paths that cannot be opened or listed (PERMISSION_DENIED). */
  deniedPaths?: string[]
  /** Passwords only through keyboard-interactive, as some servers take them. */
  keyboardInteractiveOnly?: boolean
  /** READ requests are never answered: a transfer that stalls. */
  stallReads?: boolean
  /** Entries per READDIR answer. */
  readdirBatch?: number
}

export interface TestSftpServer {
  host: '127.0.0.1'
  port: number
  /** The fingerprint of the host key: what a check returns and an access pins. */
  hostKey: string
  /** Every authentication request, in order. */
  authAttempts: { method: string; username: string }[]
  /** Every request that would have changed the server (refused). */
  writeAttempts: string[]
  /** Bytes sent in answers to READ. */
  bytesServed(): number
  close(): Promise<void>
}

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function attrsOf(node: TreeNode): Attributes {
  const now = Math.floor(Date.UTC(2026, 9, 17) / 1000)
  const mode =
    node.type === 'file'
      ? S_IFREG | 0o644
      : node.type === 'directory'
        ? S_IFDIR | 0o755
        : S_IFLNK | 0o777
  const size =
    node.type === 'file' ? node.data.length : node.type === 'link' ? node.target.length : 4096
  return { mode, uid: 1000, gid: 1000, size, atime: now, mtime: now }
}

function longNameOf(name: string, node: TreeNode): string {
  const kind =
    node.type === 'file' ? '-rw-r--r--' : node.type === 'directory' ? 'drwxr-xr-x' : 'lrwxrwxrwx'
  return `${kind} 1 site site ${attrsOf(node).size} Oct 17 00:00 ${name}`
}

function publicKeyOf(line: string): ParsedKey {
  const parsed = utils.parseKey(line)
  if (parsed instanceof Error) throw new TypeError('not an SSH public key')
  return parsed
}

export async function startTestSftpServer(options: TestSftpServerOptions): Promise<TestSftpServer> {
  const tree = new TestTree({
    files: options.files,
    directories: options.directories,
    links: options.links,
  })
  const home = normalizePath('/', options.home ?? '/')
  const denied = new Set((options.deniedPaths ?? []).map((path) => normalizePath('/', path)))
  const batchSize = options.readdirBatch ?? 64
  const hostKeyPem = options.hostKeyPem ?? generateTestSshKey().privateKey
  const users = new Map(
    options.users.map((user) => [
      user.username,
      { ...user, key: user.publicKey === undefined ? null : publicKeyOf(user.publicKey) },
    ]),
  )
  const authAttempts: { method: string; username: string }[] = []
  const writeAttempts: string[] = []
  let served = 0
  const connections = new Set<Connection>()

  function authenticate(context: AuthContext): void {
    authAttempts.push({ method: context.method, username: context.username })
    const user = users.get(context.username)
    const methods = (['password', 'publickey', 'keyboard-interactive'] as const).filter(
      (method) => !(method === 'password' && options.keyboardInteractiveOnly),
    )
    if (!user) return context.reject([...methods])
    switch (context.method) {
      case 'password':
        if (
          !options.keyboardInteractiveOnly &&
          user.password !== undefined &&
          context.password === user.password
        )
          return context.accept()
        return context.reject([...methods])
      case 'keyboard-interactive':
        if (user.password === undefined) return context.reject([...methods])
        return context.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          answers[0] === user.password ? context.accept() : context.reject([...methods]),
        )
      case 'publickey': {
        const key = user.key
        if (!key || !context.key.data.equals(key.getPublicSSH()))
          return context.reject([...methods])
        // The first request only asks whether the key would do; the second carries the signature.
        if (!context.signature || !context.blob) return context.accept()
        return key.verify(context.blob, context.signature, context.hashAlgo) === true
          ? context.accept()
          : context.reject([...methods])
      }
      default:
        return context.reject([...methods])
    }
  }

  function serve(sftp: SFTPWrapper): void {
    const handles = new Map<
      number,
      { kind: 'file'; data: Buffer } | { kind: 'dir'; entries: FileEntry[] }
    >()
    let nextHandle = 0
    const handleOf = (buffer: Buffer) => (buffer.length === 4 ? buffer.readUInt32BE(0) : -1)
    const issue = (
      value: { kind: 'file'; data: Buffer } | { kind: 'dir'; entries: FileEntry[] },
    ) => {
      const id = nextHandle++
      handles.set(id, value)
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32BE(id, 0)
      return buffer
    }
    const absolute = (path: string) => normalizePath(home, path)
    const refuse = (request: string) => (id: number) => {
      writeAttempts.push(request)
      sftp.status(id, STATUS.PERMISSION_DENIED)
    }

    sftp.on('REALPATH', (id, path) => {
      const found = tree.resolve(absolute(path))
      if (!found) return sftp.status(id, STATUS.NO_SUCH_FILE)
      sftp.name(id, [{ filename: found.path, longname: found.path, attrs: {} as Attributes }])
    })
    const stat = (follow: boolean) => (id: number, path: string) => {
      const found = tree.resolve(absolute(path), follow)
      if (!found) return sftp.status(id, STATUS.NO_SUCH_FILE)
      sftp.attrs(id, attrsOf(found.node))
    }
    sftp.on('STAT', stat(true))
    sftp.on('LSTAT', stat(false))
    sftp.on('OPENDIR', (id, path) => {
      const found = tree.resolve(absolute(path))
      if (!found) return sftp.status(id, STATUS.NO_SUCH_FILE)
      if (denied.has(found.path)) return sftp.status(id, STATUS.PERMISSION_DENIED)
      if (found.node.type !== 'directory') return sftp.status(id, STATUS.FAILURE)
      const entries = tree.children(found.path).map(({ name, path: child, node }) => {
        const shown = tree.shown(child, node, options.listLinksAsTargets === true)
        return { filename: name, longname: longNameOf(name, shown), attrs: attrsOf(shown) }
      })
      sftp.handle(id, issue({ kind: 'dir', entries }))
    })
    sftp.on('READDIR', (id, buffer) => {
      const handle = handles.get(handleOf(buffer))
      if (!handle || handle.kind !== 'dir') return sftp.status(id, STATUS.FAILURE)
      if (handle.entries.length === 0) return sftp.status(id, STATUS.EOF)
      sftp.name(id, handle.entries.splice(0, batchSize))
    })
    sftp.on('OPEN', (id, path, flags) => {
      if (flags & WRITE_FLAGS) return refuse(`OPEN ${path}`)(id)
      const found = tree.resolve(absolute(path))
      if (!found) return sftp.status(id, STATUS.NO_SUCH_FILE)
      if (denied.has(found.path)) return sftp.status(id, STATUS.PERMISSION_DENIED)
      if (found.node.type !== 'file') return sftp.status(id, STATUS.FAILURE)
      sftp.handle(id, issue({ kind: 'file', data: found.node.data }))
    })
    sftp.on('READ', (id, buffer, offset, length) => {
      if (options.stallReads) return
      const handle = handles.get(handleOf(buffer))
      if (!handle || handle.kind !== 'file') return sftp.status(id, STATUS.FAILURE)
      if (offset >= handle.data.length) return sftp.status(id, STATUS.EOF)
      const chunk = handle.data.subarray(offset, Math.min(handle.data.length, offset + length))
      served += chunk.length
      sftp.data(id, chunk)
    })
    sftp.on('FSTAT', (id, buffer) => {
      const handle = handles.get(handleOf(buffer))
      if (!handle || handle.kind !== 'file') return sftp.status(id, STATUS.FAILURE)
      sftp.attrs(id, attrsOf({ type: 'file', data: handle.data }))
    })
    sftp.on('CLOSE', (id, buffer) => {
      sftp.status(id, handles.delete(handleOf(buffer)) ? STATUS.OK : STATUS.FAILURE)
    })
    sftp.on('READLINK', (id, path) => {
      const found = tree.resolve(absolute(path), false)
      if (!found || found.node.type !== 'link') return sftp.status(id, STATUS.NO_SUCH_FILE)
      sftp.name(id, [
        { filename: found.node.target, longname: found.node.target, attrs: {} as Attributes },
      ])
    })
    for (const request of [
      'WRITE',
      'FSETSTAT',
      'SETSTAT',
      'REMOVE',
      'RMDIR',
      'MKDIR',
      'RENAME',
      'SYMLINK',
    ]) {
      sftp.on(request, refuse(request))
    }
    sftp.on('EXTENDED', (id: number) => sftp.status(id, STATUS.OP_UNSUPPORTED))
  }

  const server = new Server({ hostKeys: [hostKeyPem] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('error', () => {})
    connection.on('authentication', authenticate)
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => serve(acceptSftp()))
        // A shell or a command is never offered: the adapter must not need one.
        session.on('exec', (_accept, reject) => {
          writeAttempts.push('exec')
          reject()
        })
        session.on('shell', (_accept, reject) => {
          writeAttempts.push('shell')
          reject()
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    host: '127.0.0.1',
    port,
    hostKey: sshFingerprintOf(publicLineOf(hostKeyPem)),
    authAttempts,
    writeAttempts,
    bytesServed: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.end()
        server.close(() => resolve())
      }),
  }
}

/** The public half of a private key as an `authorized_keys` line. */
function publicLineOf(privateKey: string): string {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw new TypeError('not an SSH private key')
  return `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`
}
