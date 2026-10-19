import { Socket } from 'node:net'
import { Duplex } from 'node:stream'

import type { PinnedAddress } from '@repo/domain'

// The socket a database driver is handed instead of dialling itself. It connects to the pinned
// literal only (whatever host the driver passes), counts every byte the server sends — before TLS,
// so the handshake counts too — and destroys itself past the cap: a check never buffers more than
// checkReceivedBytes of what a server chose to send. A driver wraps it in TLS like any socket.

export class ReceivedBytesExceeded extends Error {
  constructor() {
    super('The server sent more than a check reads')
    this.name = 'ReceivedBytesExceeded'
  }
}

export interface BoundedSocketOptions {
  address: PinnedAddress
  port: number
  maxReceivedBytes: number
  /** mysql2 reads from a stream it is given and never connects it; pg calls `connect` itself. */
  connectNow: boolean
}

export class BoundedSocket extends Duplex {
  /** The first byte the server sent, or null: PostgreSQL answers an SSLRequest with `S` or `N`. */
  firstByte: number | null = null
  /** The server sent more than `maxReceivedBytes`: the socket was destroyed for it. */
  exceeded = false
  receivedBytes = 0
  private readonly socket = new Socket()
  private readonly options: BoundedSocketOptions
  private started = false

  constructor(options: BoundedSocketOptions) {
    super()
    this.options = options
    // Node checks a certificate against `socket._host` when TLS is given this socket without a
    // name or host (mysql2 passes none for an IP literal): the literal, never `localhost`.
    Object.defineProperty(this, '_host', { value: options.address.address, enumerable: false })
    // A refused connection before the driver listens (mysql2 is handed a socket that is already
    // dialling) must not reach the process; the driver's own listeners still see every error.
    this.on('error', () => {})
    const { socket } = this
    socket.on('connect', () => this.emit('connect'))
    socket.on('data', (chunk: Buffer) => {
      if (this.firstByte === null && chunk.length > 0) this.firstByte = chunk[0] ?? null
      this.receivedBytes += chunk.length
      if (this.receivedBytes > options.maxReceivedBytes) {
        this.exceeded = true
        this.destroy(new ReceivedBytesExceeded())
        return
      }
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => {
      if (!this.destroyed) this.destroy()
    })
    if (options.connectNow) this.connect()
  }

  /** Dials the pinned literal and port; the arguments of a driver are ignored. */
  connect(..._ignored: unknown[]): this {
    if (this.started) return this
    this.started = true
    this.socket.connect({ host: this.options.address.address, port: this.options.port })
    return this
  }

  setNoDelay(noDelay?: boolean): this {
    this.socket.setNoDelay(noDelay)
    return this
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.socket.setKeepAlive(enable, initialDelay)
    return this
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.socket.setTimeout(timeout, callback)
    return this
  }

  ref(): this {
    this.socket.ref()
    return this
  }

  unref(): this {
    this.socket.unref()
    return this
  }

  override _read(): void {
    this.socket.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.socket.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end()
    callback()
  }

  /**
   * `close` waits a turn of the event loop: when a TLS socket over this one fails its handshake, it
   * destroys this socket before it reports why, and a driver that hears `close` first answers "the
   * server closed the connection" instead of the certificate error that `certificate_untrusted` reads.
   */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy()
    setImmediate(() => callback(error))
  }
}
