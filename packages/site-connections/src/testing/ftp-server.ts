import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'

import { normalizePath, parentOf, TestTree, type TreeNode } from './tree.ts'

// A minimal FTP server on loopback over an in-memory, read-only tree: what the FTP adapter is tested
// against, not a server to rely on. It speaks explicit TLS (AUTH TLS, PBSZ, PROT), passive data
// connections only (EPSV, PASV) on 127.0.0.1, MLSD and LIST, RETR and SIZE. Everything on the wire
// is latin1: a name is its bytes. Commands that would change the tree are refused and recorded.

export interface TestFtpServerOptions {
  /** Path → content; relative paths start at `/`. Parent folders are created. */
  files: Record<string, string | Uint8Array>
  directories?: string[]
  username: string
  password: string
  /** Offer AUTH TLS with this leaf; without it AUTH is refused (a server with no TLS). */
  tls?: { key: string; cert: string } | null
  /** Refuse USER before AUTH TLS, as vsftpd with `force_local_logins_ssl`. */
  requireTls?: boolean
  /** The code of that refusal: 530 as vsftpd (the default), or 534 as IIS («Policy requires SSL»). */
  requireTlsCode?: 530 | 534
  /**
   * How the keys of `files`, `directories` and `links` become the bytes of names: `utf8` (the
   * default), or `latin1` for keys that already are a latin1 string of raw bytes (a cp1251 name).
   */
  nameEncoding?: 'utf8' | 'latin1'
  /** Path → target: symbolic links of the tree. CWD follows them and PWD names the target. */
  links?: Record<string, string>
  /** List a link as what it points to, as a server whose MLSD shows a linked folder as a folder. */
  listLinksAsTargets?: boolean
  /** Answer EPSV with 500, as a server that knows only PASV. */
  epsv?: boolean
  /** The address a PASV reply names (127.0.0.1 by default): a reply that points elsewhere. */
  pasvAddress?: string
  /** Advertise MLST and serve MLSD (the default); without, LIST only. */
  mlsd?: boolean
  /** Refuse a protected data connection that does not resume the session of the control one. */
  requireSessionReuse?: boolean
  /** The login folder. `/` by default. */
  home?: string
  /** Paths that cannot be entered or read (550). */
  deniedPaths?: string[]
  /** Transfers send this many bytes, then nothing more and never end. */
  stallTransfersAfter?: number
}

export interface TestFtpServer {
  host: '127.0.0.1'
  port: number
  /** Every command received, in order; the argument of PASS is never kept. */
  commands: string[]
  /** Commands that would have changed the server (refused). */
  writeAttempts: string[]
  /** Each data connection: whether it was protected and whether it resumed the control session. */
  dataConnections: { protected: boolean; resumed: boolean }[]
  /** Control connections opened so far. */
  logins(): number
  /** The most control connections that were open at the same time. */
  peakConnections(): number
  close(): Promise<void>
}

const WRITES = new Set([
  'STOR',
  'STOU',
  'APPE',
  'DELE',
  'RMD',
  'XRMD',
  'MKD',
  'XMKD',
  'RNFR',
  'RNTO',
  'SITE',
  'MFMT',
  'MFCT',
  'MFF',
  'ALLO',
])
const BEFORE_LOGIN = new Set([
  'USER',
  'PASS',
  'AUTH',
  'PBSZ',
  'PROT',
  'FEAT',
  'OPTS',
  'SYST',
  'QUIT',
  'NOOP',
])

function encoder(encoding: 'utf8' | 'latin1'): (key: string) => string {
  return encoding === 'utf8' ? (key) => Buffer.from(key, 'utf8').toString('latin1') : (key) => key
}

function sizeOf(node: TreeNode): number {
  return node.type === 'file' ? node.data.length : node.type === 'link' ? node.target.length : 4096
}

function mlsdLine(name: string, node: TreeNode): string {
  const type = node.type === 'file' ? 'file' : node.type === 'directory' ? 'dir' : 'OS.unix=symlink'
  return `type=${type};size=${sizeOf(node)};modify=20261017000000; ${name}`
}

function listLine(name: string, node: TreeNode): string {
  const mode =
    node.type === 'file' ? '-rw-r--r--' : node.type === 'directory' ? 'drwxr-xr-x' : 'lrwxrwxrwx'
  const shown = node.type === 'link' ? `${name} -> ${node.target}` : name
  return `${mode}    1 site     site     ${String(sizeOf(node)).padStart(8)} Oct 17 00:00 ${shown}`
}

interface DataChannel {
  socket: Promise<Socket | TLSSocket | null>
  close(): void
}

class ControlSession {
  private socket: Socket | TLSSocket
  private buffer = ''
  private chain: Promise<void> = Promise.resolve()
  private user: string | null = null
  private loggedIn = false
  private secure = false
  private protect = false
  private cwd: string
  private data: DataChannel | null = null
  private readonly server: FtpFake

  constructor(socket: Socket, server: FtpFake) {
    this.socket = socket
    this.server = server
    this.cwd = server.home
    this.listen(socket)
    socket.on('error', () => {})
    this.reply('220 Raditi test FTP')
  }

  private readonly onData = (chunk: string) => {
    this.buffer += chunk
    for (let end = this.buffer.indexOf('\n'); end !== -1; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '')
      this.buffer = this.buffer.slice(end + 1)
      this.chain = this.chain
        .then(() => this.handle(line))
        .catch(() => {
          this.socket.destroy()
        })
    }
  }

  private listen(socket: Socket | TLSSocket): void {
    socket.setEncoding('latin1')
    socket.on('data', this.onData)
  }

  private reply(text: string): void {
    if (!this.socket.destroyed) this.socket.write(`${text}\r\n`, 'latin1')
  }

  private resolve(argument: string): string {
    return normalizePath(this.cwd, argument === '' ? '.' : argument)
  }

  private async openData(): Promise<number> {
    this.data?.close()
    const listener: Server = createServer()
    const { context, requireSessionReuse } = this.server
    const protect = this.protect && this.secure
    const socket = new Promise<Socket | TLSSocket | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000)
      listener.once('connection', (raw: Socket) => {
        clearTimeout(timer)
        listener.close()
        raw.on('error', () => {})
        if (!protect || !context) {
          this.server.dataConnections.push({ protected: false, resumed: false })
          resolve(raw)
          return
        }
        const tls = new TLSSocket(raw, { isServer: true, secureContext: context })
        tls.on('error', () => resolve(null))
        tls.once('secure', () => {
          const resumed = tls.isSessionReused()
          this.server.dataConnections.push({ protected: true, resumed })
          if (requireSessionReuse && !resumed) {
            tls.destroy()
            resolve(null)
            return
          }
          resolve(tls)
        })
      })
    })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    this.data = {
      socket,
      close: () => {
        listener.close()
        void socket.then((open) => open?.destroy())
      },
    }
    return (listener.address() as AddressInfo).port
  }

  /** 150, the payload, the end of the data connection, then 226. */
  private async transfer(payload: Buffer): Promise<void> {
    const channel = this.data
    this.data = null
    const socket = channel ? await channel.socket : null
    if (!socket) {
      this.reply('425 Cannot open data connection.')
      return
    }
    this.reply('150 Opening BINARY mode data connection.')
    const stall = this.server.stallTransfersAfter
    if (stall !== undefined) {
      socket.write(payload.subarray(0, stall))
      return
    }
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.end(payload)
    })
    this.reply('226 Transfer complete.')
  }

  private listing(path: string, machine: boolean): Buffer | null {
    const found = this.server.tree.resolve(path)
    if (!found || found.node.type !== 'directory' || this.server.denied.has(found.path)) return null
    const lines = this.server.tree.children(found.path).map(({ name, path: child, node }) => {
      const shown = this.server.tree.shown(child, node, this.server.listLinksAsTargets)
      return machine ? mlsdLine(name, shown) : listLine(name, shown)
    })
    return Buffer.from(lines.map((line) => `${line}\r\n`).join(''), 'latin1')
  }

  private async handle(line: string): Promise<void> {
    const space = line.indexOf(' ')
    const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase()
    const argument = space === -1 ? '' : line.slice(space + 1)
    this.server.commands.push(verb === 'PASS' ? 'PASS ***' : line)

    if (!this.loggedIn && !BEFORE_LOGIN.has(verb))
      return this.reply('530 Please login with USER and PASS.')
    if (WRITES.has(verb)) {
      this.server.writeAttempts.push(line)
      return this.reply('550 Permission denied.')
    }
    switch (verb) {
      case 'AUTH': {
        const { context } = this.server
        if (!context || !/^(TLS|SSL)$/i.test(argument))
          return this.reply('502 Security scheme not implemented.')
        this.reply('234 Proceed with negotiation.')
        const raw = this.socket as Socket
        raw.removeListener('data', this.onData)
        const tls = new TLSSocket(raw, { isServer: true, secureContext: context })
        tls.on('error', () => {})
        this.socket = tls
        this.secure = true
        this.listen(tls)
        return
      }
      case 'PBSZ':
        return this.reply(this.secure ? '200 PBSZ=0' : '503 PBSZ needs a secure connection.')
      case 'PROT':
        if (!this.secure) return this.reply('503 PROT needs a secure connection.')
        this.protect = argument.toUpperCase() === 'P'
        return this.reply(`200 Protection level set to ${this.protect ? 'P' : 'C'}.`)
      case 'USER':
        if (this.server.requireTls && !this.secure)
          return this.reply(
            this.server.requireTlsCode === 534
              ? '534 Policy requires SSL.'
              : '530 Non-anonymous sessions must use encryption.',
          )
        this.user = argument
        return this.reply('331 Please specify the password.')
      case 'PASS':
        if (this.user === this.server.username && argument === this.server.password) {
          this.loggedIn = true
          return this.reply('230 Login successful.')
        }
        return this.reply('530 Login incorrect.')
      case 'FEAT':
        return this.reply(
          [
            '211-Features:',
            ...(this.server.mlsd ? [' MLST type*;size*;modify*;'] : []),
            ' UTF8',
            ' EPSV',
            ' PASV',
            ' SIZE',
          ]
            .concat(this.server.context ? [' AUTH TLS', ' PBSZ', ' PROT'] : [])
            .concat('211 End')
            .join('\r\n'),
        )
      case 'OPTS':
      case 'TYPE':
      case 'STRU':
      case 'MODE':
      case 'NOOP':
        return this.reply('200 OK.')
      case 'SYST':
        return this.reply('215 UNIX Type: L8')
      case 'PWD':
      case 'XPWD':
        return this.reply(`257 "${this.cwd.replace(/"/g, '""')}" is the current directory`)
      case 'CWD':
      case 'XCWD': {
        const found = this.server.tree.resolve(this.resolve(argument))
        if (!found || found.node.type !== 'directory' || this.server.denied.has(found.path))
          return this.reply('550 Failed to change directory.')
        this.cwd = found.path
        return this.reply('250 Directory successfully changed.')
      }
      case 'CDUP':
        this.cwd = parentOf(this.cwd)
        return this.reply('250 Directory successfully changed.')
      case 'EPSV':
        if (!this.server.epsv) return this.reply('500 EPSV not understood.')
        return this.reply(`229 Entering Extended Passive Mode (|||${await this.openData()}|)`)
      case 'PASV': {
        const port = await this.openData()
        const host = this.server.pasvAddress.split('.').join(',')
        return this.reply(
          `227 Entering Passive Mode (${host},${Math.floor(port / 256)},${port % 256}).`,
        )
      }
      case 'PORT':
      case 'EPRT':
        return this.reply('500 Active mode is not supported.')
      case 'MLSD':
      case 'LIST':
      case 'NLST': {
        if (verb === 'MLSD' && !this.server.mlsd) return this.reply('500 Unknown command.')
        const path = argument
          .split(' ')
          .filter((part) => part !== '' && !part.startsWith('-'))
          .join(' ')
        const payload = this.listing(this.resolve(path), verb === 'MLSD')
        if (!payload) {
          this.data?.close()
          this.data = null
          return this.reply('550 Failed to list.')
        }
        return this.transfer(payload)
      }
      case 'MLST': {
        // The facts of one path, on the control connection; like SIZE it does not open the entry.
        if (!this.server.mlsd) return this.reply('500 Unknown command.')
        const found = this.server.tree.resolve(this.resolve(argument))
        if (!found) return this.reply('550 No such file or directory.')
        return this.reply(
          [`250-Listing ${found.path}`, ` ${mlsdLine(found.path, found.node)}`, '250 End.'].join(
            '\r\n',
          ),
        )
      }
      case 'SIZE': {
        const found = this.server.tree.resolve(this.resolve(argument))
        if (!found || found.node.type !== 'file') return this.reply('550 Could not get file size.')
        return this.reply(`213 ${found.node.data.length}`)
      }
      case 'RETR': {
        const found = this.server.tree.resolve(this.resolve(argument))
        if (!found || found.node.type !== 'file' || this.server.denied.has(found.path)) {
          this.data?.close()
          this.data = null
          return this.reply('550 Failed to open file.')
        }
        return this.transfer(found.node.data)
      }
      case 'ABOR':
        this.data?.close()
        this.data = null
        return this.reply('226 Abort successful.')
      case 'QUIT':
        this.reply('221 Goodbye.')
        this.socket.end()
        return
      default:
        return this.reply('502 Command not implemented.')
    }
  }

  close(): void {
    this.data?.close()
    this.socket.destroy()
  }
}

/** The state the sessions of one fake share. */
class FtpFake {
  readonly tree: TestTree
  readonly home: string
  readonly denied: Set<string>
  readonly context: SecureContext | null
  readonly username: string
  readonly password: string
  readonly requireTls: boolean
  readonly requireTlsCode: 530 | 534
  readonly requireSessionReuse: boolean
  readonly listLinksAsTargets: boolean
  readonly epsv: boolean
  readonly mlsd: boolean
  readonly pasvAddress: string
  readonly stallTransfersAfter: number | undefined
  readonly commands: string[] = []
  readonly writeAttempts: string[] = []
  readonly dataConnections: { protected: boolean; resumed: boolean }[] = []

  constructor(options: TestFtpServerOptions) {
    const encode = encoder(options.nameEncoding ?? 'utf8')
    this.tree = new TestTree({
      files: options.files,
      directories: options.directories,
      links: options.links,
      encode,
    })
    this.home = normalizePath('/', encode(options.home ?? '/'))
    this.denied = new Set(
      (options.deniedPaths ?? []).map((path) => normalizePath('/', encode(path))),
    )
    // One context for the control and every data connection: its ticket keys let a data connection resume.
    this.context = options.tls
      ? createSecureContext({ key: options.tls.key, cert: options.tls.cert })
      : null
    this.username = encode(options.username)
    this.password = encode(options.password)
    this.requireTls = options.requireTls === true
    this.requireTlsCode = options.requireTlsCode ?? 530
    this.requireSessionReuse = options.requireSessionReuse === true
    this.listLinksAsTargets = options.listLinksAsTargets === true
    this.epsv = options.epsv !== false
    this.mlsd = options.mlsd !== false
    this.pasvAddress = options.pasvAddress ?? '127.0.0.1'
    this.stallTransfersAfter = options.stallTransfersAfter
  }
}

export async function startTestFtpServer(options: TestFtpServerOptions): Promise<TestFtpServer> {
  const fake = new FtpFake(options)
  const sessions = new Set<ControlSession>()
  let logins = 0
  let open = 0
  let peak = 0
  const server = createServer((socket) => {
    logins += 1
    open += 1
    peak = Math.max(peak, open)
    const session = new ControlSession(socket, fake)
    sessions.add(session)
    socket.on('close', () => {
      open -= 1
      sessions.delete(session)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    host: '127.0.0.1',
    port,
    commands: fake.commands,
    writeAttempts: fake.writeAttempts,
    dataConnections: fake.dataConnections,
    logins: () => logins,
    peakConnections: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.close()
        server.close(() => resolve())
      }),
  }
}
