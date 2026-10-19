/* global Buffer, TextDecoder, console, process */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'

// Trusted writer of a preview's docroot (docs/plan/53-chat-preview-release.md, Р22, Р23). It runs
// in a container that mounts that one volume at ROOT and nothing else: no network, no other volume,
// a read-only root file system. It takes a frame and a tar on stdin and writes regular files and
// directories only. Links, devices, `..`, absolute paths and names that are not UTF-8 are refused,
// and so is a write through an existing link on any component of the path: every directory is
// opened without following links and the next name is resolved under that open descriptor
// (/proc/self/fd), as the sandbox helper does (packages/sandbox-providers/runtime/runtime.mjs).
//
// The platform's own files of the stack (docs/plan/53-chat-preview-release.md, R5b, R5c) are
// written by `platform`, run as root with CAP_CHOWN alone: root's with mode 0444, and every folder
// on their way — the root of the tree included — root's with the PHP user's group and mode 1775,
// so that user creates and removes its own entries there and never the platform's, nor renames a
// folder that holds them. `release` gives that layout back to the PHP user before a whole tree
// replaces the docroot.
//
// The PHP of the preview writes into the same volume while this runs. A race of it against these
// checks can redirect a write only inside this container's view: the volume itself and a read-only
// root, which that PHP can already write to or not at all.

export const ROOT = '/files'
export const filesLimits = Object.freeze({
  /** The JSON frame before the archive. */
  frameBytes: 1024 * 1024,
  deletes: 10_000,
  entries: 200_000,
  totalBytes: 4 * 1024 ** 3,
  fileBytes: 1024 ** 3,
  pathBytes: 4096,
  nameBytes: 255,
  depth: 64,
  /** A pax or GNU long-name header. */
  metaBytes: 64 * 1024,
  /** Zero padding after the end of the archive. */
  trailerBytes: 1024 * 1024,
  /** Entries a removal walks through. */
  removals: 500_000,
  /** The platform's files: their number and the size of one. */
  platformFiles: 16,
  // The plugin «Радити» of version 2 is above 64 KiB (plan 53, «Операции БД и миграции»).
  platformFileBytes: 192 * 1024,
})

/** Folders that hold the platform's files: root's, the PHP user's group, sticky (R5b). */
export const PLATFORM_FOLDER_MODE = 0o1775
export const PLATFORM_FILE_MODE = 0o444

export class FilesRefused extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'FilesRefused'
    this.reason = reason
  }
}
const refuse = (reason) => {
  throw new FilesRefused(reason)
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
const decode = (bytes) => {
  try {
    return utf8.decode(bytes)
  } catch {
    return refuse('name_encoding')
  }
}
const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | noFollow

/**
 * The names of a relative path of the tree; null when the path is not one. A directory entry may
 * end with `/`; a leading `./` (a tar of `.`) is dropped, and the root itself is `[]`.
 */
export function pathNames(raw, { directory = false, limits = filesLimits } = {}) {
  if (typeof raw !== 'string') return null
  let path = raw.startsWith('./') ? raw.slice(2) : raw
  if (directory && path.endsWith('/')) path = path.slice(0, -1)
  if (directory && (path === '' || path === '.')) return []
  if (path === '' || Buffer.byteLength(path) > limits.pathBytes) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return null
  const names = path.split('/')
  if (names.length > limits.depth) return null
  if (
    names.some(
      (name) =>
        name === '' || name === '.' || name === '..' || Buffer.byteLength(name) > limits.nameBytes,
    )
  )
    return null
  return names
}

// --- The archive: ustar and pax, files and directories only ---------------------------------

const zeroBlock = (block) => block.every((byte) => byte === 0)
const cString = (bytes) => {
  const end = bytes.indexOf(0)
  return end < 0 ? bytes : bytes.subarray(0, end)
}
const octal = (bytes) => {
  const text = cString(bytes).toString('latin1').trim()
  if (!/^[0-7]{1,12}$/.test(text)) refuse('header')
  return parseInt(text, 8)
}

/** One 512-byte header; refuses a bad checksum, an unknown format and any other entry type. */
export function parseHeader(block) {
  if (block.length !== 512) refuse('header')
  let sum = 0
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]
  if (octal(block.subarray(148, 156)) !== sum) refuse('checksum')
  const magic = block.subarray(257, 263).toString('latin1')
  const posix = magic === 'ustar\0'
  if (!posix && magic !== 'ustar ') refuse('format')
  const flag = String.fromCharCode(block[156])
  const types = { '\0': 'file', 0: 'file', 5: 'directory', x: 'pax', g: 'global', L: 'longname' }
  const type = types[flag] ?? refuse('entry_type')
  const name = decode(cString(block.subarray(0, 100)))
  // In the GNU format these bytes hold times, never a prefix.
  const prefix = posix ? decode(cString(block.subarray(345, 500))) : ''
  return {
    type,
    name: prefix ? `${prefix}/${name}` : name,
    mode: octal(block.subarray(100, 108)) & 0o7777,
    size: octal(block.subarray(124, 136)),
  }
}

/** Pax records `<length> <key>=<value>\n`: only `path` matters; a pax `size` is refused. */
export function parsePax(bytes) {
  const result = {}
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset)
    if (space < 0 || space - offset > 10) refuse('pax')
    const length = Number(bytes.subarray(offset, space).toString('latin1'))
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) refuse('pax')
    const record = bytes.subarray(space + 1, offset + length)
    if (offset + length > bytes.length || record.at(-1) !== 0x0a) refuse('pax')
    const text = decode(record.subarray(0, -1))
    const equals = text.indexOf('=')
    if (equals < 1) refuse('pax')
    const key = text.slice(0, equals)
    if (key === 'path') result.path = text.slice(equals + 1)
    else if (key === 'size') refuse('file_too_large')
    offset += length
  }
  return result
}

/** Exact reads over an async iterable of chunks. */
export class Input {
  #iterator
  #buffer = Buffer.alloc(0)
  #done = false
  constructor(iterable) {
    this.#iterator = iterable[Symbol.asyncIterator]()
  }
  async #more() {
    if (this.#done) return false
    const { value, done } = await this.#iterator.next()
    if (done) {
      this.#done = true
      return false
    }
    if (!(value instanceof Uint8Array)) refuse('input')
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, value])
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return true
  }
  /** Exactly `length` bytes, or null at the end of the input. */
  async read(length) {
    while (this.#buffer.length < length) if (!(await this.#more())) break
    if (this.#buffer.length < length) {
      if (this.#buffer.length === 0) return null
      refuse('truncated')
    }
    const bytes = this.#buffer.subarray(0, length)
    this.#buffer = this.#buffer.subarray(length)
    return bytes
  }
  /** Yields exactly `length` bytes in the chunks they arrived in. */
  async *take(length) {
    let left = length
    while (left > 0) {
      if (!this.#buffer.length && !(await this.#more())) refuse('truncated')
      const part = this.#buffer.subarray(0, Math.min(left, this.#buffer.length))
      this.#buffer = this.#buffer.subarray(part.length)
      left -= part.length
      yield part
    }
  }
  /** The rest must be zero padding, at most `limit` bytes. */
  async drainZeros(limit) {
    let seen = 0
    do {
      seen += this.#buffer.length
      if (seen > limit || !zeroBlock(this.#buffer)) refuse('trailer')
      this.#buffer = Buffer.alloc(0)
    } while (await this.#more())
  }
}

// --- The tree: no-follow walks under open descriptors ----------------------------------------

/** gVisor opens a link to a directory even with O_NOFOLLOW: the name must be that inode. */
async function openDirectory(path) {
  let handle
  try {
    handle = await fs.open(path, directoryFlags)
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    return refuse('path_conflict')
  }
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(path)])
    if (!named.isDirectory() || opened.ino !== named.ino || opened.dev !== named.dev)
      refuse('path_conflict')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
const under = (handle, name) => `/proc/self/fd/${handle.fd}/${name}`
const missing = (error) => error?.code === 'ENOENT'

/**
 * Opens the directory that holds the last name, creating the ones before it when asked.
 * Returns null when a directory on the way is missing and nothing may be created.
 */
async function parentOf(root, names, create) {
  const handles = []
  let current = root
  try {
    for (const name of names.slice(0, -1)) {
      const next = under(current, name)
      if (create)
        await fs.mkdir(next, { mode: 0o755 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
      try {
        current = await openDirectory(next)
      } catch (error) {
        if (missing(error) && !create) {
          for (const handle of handles.reverse()) await handle.close()
          return null
        }
        throw error
      }
      handles.push(current)
    }
    return {
      directory: current,
      close: async () => {
        for (const handle of handles.reverse()) await handle.close()
      },
    }
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {})
    throw error
  }
}

async function makeDirectory(root, names) {
  if (!names.length) return
  const parent = await parentOf(root, names, true)
  try {
    const path = under(parent.directory, names.at(-1))
    await fs.mkdir(path, { mode: 0o755 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
    await (await openDirectory(path)).close()
  } finally {
    await parent.close()
  }
}

async function writeFile(root, names, mode, content) {
  const parent = await parentOf(root, names, true)
  const final = under(parent.directory, names.at(-1))
  const temporary = under(parent.directory, `.raditi-${randomUUID()}`)
  let handle
  try {
    const existing = await fs.lstat(final).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    if (existing && !existing.isFile()) refuse('path_conflict')
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    )
    for await (const chunk of content) await handle.write(chunk)
    await handle.chmod(mode)
    await handle.close()
    handle = undefined
    // rename replaces the name itself: a link put there since the check is replaced, never followed.
    await fs.rename(temporary, final)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(temporary).catch(() => {})
    throw error
  } finally {
    await parent.close()
  }
}

/** Removes a name of an open directory: files and links unlinked, directories walked unfollowed. */
async function removeName(directory, name, budget) {
  if (--budget.left < 0) refuse('too_many_entries')
  const path = under(directory, name)
  const stat = await fs.lstat(path).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory()) {
    await fs.unlink(path)
    return
  }
  const handle = await openDirectory(path)
  try {
    for (const child of await fs.readdir(under(handle, '.')))
      await removeName(handle, child, budget)
  } finally {
    await handle.close()
  }
  await fs.rmdir(path)
}

async function removePath(root, names, budget) {
  const parent = await parentOf(root, names, false)
  if (!parent) return
  try {
    await removeName(parent.directory, names.at(-1), budget)
  } finally {
    await parent.close()
  }
}

// --- Commands ---------------------------------------------------------------------------------

/**
 * The docroot must be a directory of this user: the volume as the helper prepared it. The PHP of
 * the preview is that user too and may have taken its own rights away: they are given back.
 */
async function openRoot(root) {
  // The mount point of the volume, never a link: its rights are given back before it is opened.
  const named = await fs.lstat(root)
  if (named.isDirectory() && named.uid === process.getuid() && (named.mode & 0o700) !== 0o700)
    await fs.chmod(root, (named.mode & 0o7777) | 0o700)
  const handle = await openDirectory(root)
  const stat = await handle.stat()
  if (!(isOwnRoot(stat) || isPlatformFolder(stat, process.getgid()))) {
    await handle.close()
    refuse('root_owner')
  }
  return handle
}

const isOwnRoot = (stat) => stat.uid === process.getuid() && (stat.mode & 0o700) === 0o700
/** A folder the platform holds files in: root's, of the PHP user's group, mode 1775. */
const isPlatformFolder = (stat, gid) =>
  stat.isDirectory() &&
  stat.uid === 0 &&
  stat.gid === gid &&
  (stat.mode & 0o7777) === PLATFORM_FOLDER_MODE

/**
 * Gives a new, empty volume to the PHP user (`uid:gid`): run as root with CAP_CHOWN alone, on
 * every build. A volume that already belongs to that user is left as it is — looked at without
 * opening it, which its owner may have closed to root without DAC_OVERRIDE; one of another user
 * or with entries is never taken.
 */
export async function prepareRoot(root, owner) {
  const [, uid, gid] = /^([1-9]\d{0,5}):([1-9]\d{0,5})$/.exec(owner ?? '') ?? refuse('usage')
  // The mount point of the volume: the PHP of the preview cannot replace it.
  const current = await fs.lstat(root)
  if (current.isDirectory() && current.uid === Number(uid) && current.gid === Number(gid))
    return { ready: true }
  // Built already: the platform's files are in it (`platform`).
  if (isPlatformFolder(current, Number(gid))) return { ready: true }
  const handle = await openDirectory(root)
  try {
    const stat = await handle.stat()
    if (stat.uid === Number(uid) && stat.gid === Number(gid)) return { ready: true }
    if (stat.uid !== process.getuid() || (await fs.readdir(under(handle, '.'))).length)
      refuse('root_owner')
    // The mode first, while the folder is still ours: no CAP_FOWNER is needed after the chown.
    await handle.chmod(0o755)
    await handle.chown(Number(uid), Number(gid))
  } finally {
    await handle.close()
  }
  return { ready: true }
}

/** Reads the frame (`<u32 length><JSON>`) and the archive after it. */
export async function readFrame(input, limits = filesLimits) {
  const head = await input.read(4)
  if (!head) refuse('frame')
  const length = head.readUInt32BE(0)
  if (length < 2 || length > limits.frameBytes) refuse('frame')
  const bytes = (await input.read(length)) ?? refuse('frame')
  let frame
  try {
    frame = JSON.parse(utf8.decode(bytes))
  } catch {
    refuse('frame')
  }
  const { replace, deletes } = frame ?? {}
  if (
    typeof replace !== 'boolean' ||
    !Array.isArray(deletes) ||
    deletes.length > limits.deletes ||
    Object.keys(frame).length !== 2
  )
    refuse('frame')
  const paths = deletes.map((path) => pathNames(path, { limits }) ?? refuse('path'))
  return { replace, deletes: paths }
}

export async function writeTree(root, stdin, limits = filesLimits) {
  const input = new Input(stdin)
  const frame = await readFrame(input, limits)
  const rootHandle = await openRoot(root)
  const summary = { files: 0, directories: 0, bytes: 0, deleted: 0 }
  const budget = { left: limits.removals }
  try {
    if (frame.replace)
      for (const name of await fs.readdir(under(rootHandle, '.')))
        await removeName(rootHandle, name, budget)
    // Deletes go first: a file of the old tree may be a folder of the new one.
    for (const names of frame.deletes) {
      await removePath(rootHandle, names, budget)
      summary.deleted++
    }
    let pax = {}
    let longName
    let entries = 0
    for (;;) {
      const block = await input.read(512)
      if (!block) refuse('truncated')
      if (zeroBlock(block)) break
      if (++entries > limits.entries) refuse('too_many_entries')
      const header = parseHeader(block)
      const padding = (512 - (header.size % 512)) % 512
      if (header.type === 'pax' || header.type === 'global' || header.type === 'longname') {
        if (header.size > limits.metaBytes) refuse('header')
        const body = (await input.read(header.size + padding)) ?? refuse('truncated')
        const content = body.subarray(0, header.size)
        if (header.type === 'pax') pax = parsePax(content)
        else if (header.type === 'longname') longName = decode(cString(content))
        continue
      }
      const name = pax.path ?? longName ?? header.name
      pax = {}
      longName = undefined
      if (header.type === 'directory') {
        const names = pathNames(name, { directory: true, limits }) ?? refuse('path')
        if (header.size !== 0) refuse('header')
        await makeDirectory(rootHandle, names)
        summary.directories++
        continue
      }
      const names = pathNames(name, { limits }) ?? refuse('path')
      if (header.size > limits.fileBytes) refuse('file_too_large')
      summary.bytes += header.size
      if (summary.bytes > limits.totalBytes) refuse('too_large')
      await writeFile(
        rootHandle,
        names,
        header.mode & 0o111 ? 0o755 : 0o644,
        input.take(header.size),
      )
      if (padding) (await input.read(padding)) ?? refuse('truncated')
      summary.files++
    }
    await input.drainZeros(limits.trailerBytes)
  } finally {
    await rootHandle.close()
  }
  return summary
}

const ownerOf = (owner) => {
  const [, uid, gid] = /^([1-9]\d{0,5}):([1-9]\d{0,5})$/.exec(owner ?? '') ?? refuse('usage')
  return { uid: Number(uid), gid: Number(gid) }
}

/** The platform's files of a frame `<u32 length><JSON {files: [{path, content}]}>`. */
export async function readPlatformFiles(input, limits = filesLimits) {
  const head = await input.read(4)
  if (!head) refuse('frame')
  const length = head.readUInt32BE(0)
  const most = limits.platformFiles * (limits.platformFileBytes * 2 + limits.pathBytes + 64) + 64
  if (length < 2 || length > most) refuse('frame')
  const bytes = (await input.read(length)) ?? refuse('frame')
  let frame
  try {
    frame = JSON.parse(utf8.decode(bytes))
  } catch {
    refuse('frame')
  }
  const files = frame?.files
  if (
    !Array.isArray(files) ||
    Object.keys(frame).length !== 1 ||
    files.length > limits.platformFiles ||
    (await input.read(1)) !== null
  )
    refuse('frame')
  const seen = new Set()
  return files.map((file) => {
    if (
      typeof file?.path !== 'string' ||
      typeof file.content !== 'string' ||
      Object.keys(file).length !== 2 ||
      seen.has(file.path) ||
      Buffer.byteLength(file.content) > limits.platformFileBytes
    )
      refuse('frame')
    seen.add(file.path)
    return { names: pathNames(file.path, { limits }) ?? refuse('path'), content: file.content }
  })
}

/**
 * The folder `name` of an open folder of the platform, made the platform's: created when it is
 * missing, given to root with the PHP user's group and mode 1775 when it is not yet. Root has no
 * DAC_OVERRIDE here: it takes the folder by its name first, then opens it as its owner.
 */
async function platformFolder(parent, name, gid) {
  const path = parent === null ? name : under(parent, name)
  await fs.mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  // Opened without following a link and checked to be the inode of its name: the owner and the
  // mode are changed on that descriptor, never through a name the PHP user may swap meanwhile.
  const handle = await openDirectory(path)
  try {
    if (!isPlatformFolder(await handle.stat(), gid)) {
      await handle.chown(0, gid)
      await handle.chmod(PLATFORM_FOLDER_MODE)
      if (!isPlatformFolder(await handle.stat(), gid)) refuse('path_conflict')
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Writes the platform's files into the tree (`platform`, as root with CAP_CHOWN alone). */
export async function writePlatformFiles(root, owner, stdin, limits = filesLimits) {
  const { gid } = ownerOf(owner)
  const files = await readPlatformFiles(new Input(stdin), limits)
  for (const file of files) {
    const handles = [await platformFolder(null, root, gid)]
    try {
      for (const name of file.names.slice(0, -1))
        handles.push(await platformFolder(handles.at(-1), name, gid))
      const folder = handles.at(-1)
      const final = under(folder, file.names.at(-1))
      const existing = await fs.lstat(final).catch((error) => {
        if (missing(error)) return null
        throw error
      })
      if (existing && !existing.isFile()) refuse('path_conflict')
      const temporary = under(folder, `.raditi-${randomUUID()}`)
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        PLATFORM_FILE_MODE,
      )
      try {
        await handle.write(Buffer.from(file.content, 'utf8'))
        await handle.chmod(PLATFORM_FILE_MODE)
      } finally {
        await handle.close()
      }
      try {
        await fs.rename(temporary, final)
      } catch (error) {
        await fs.unlink(temporary).catch(() => {})
        throw error
      }
    } finally {
      for (const handle of handles.reverse()) await handle.close()
    }
  }
  return { files: files.length }
}

/**
 * Gives the tree back to the PHP user before a whole new tree replaces it (`release`, as root
 * with CAP_CHOWN alone): in every folder of root's from the root of the tree down, root's files —
 * the platform's — are removed, then the folder goes back to that user with mode 0755.
 */
export async function releasePlatformFiles(root, owner, limits = filesLimits) {
  const { uid, gid } = ownerOf(owner)
  const budget = { left: limits.removals }
  let released = 0
  const release = async (path) => {
    if (--budget.left < 0) refuse('too_many_entries')
    const handle = await openDirectory(path)
    try {
      const stat = await handle.stat()
      if (!isPlatformFolder(stat, gid)) return
      for (const name of await fs.readdir(under(handle, '.'))) {
        const child = under(handle, name)
        const entry = await fs.lstat(child)
        if (entry.uid !== 0) continue
        if (entry.isDirectory()) await release(child)
        else await fs.unlink(child)
      }
      // The mode while it is still root's: no CAP_FOWNER is needed after the chown.
      await handle.chmod(0o755)
      await handle.chown(uid, gid)
      released++
    } finally {
      await handle.close()
    }
  }
  await release(root)
  return { folders: released }
}

if (process.argv[1]?.endsWith('/files.mjs')) {
  const [command, ...rest] = process.argv.slice(2)
  const run = async () => {
    if (command === 'init' && rest.length === 1) return prepareRoot(ROOT, rest[0])
    if (command === 'write' && rest.length === 0) return writeTree(ROOT, process.stdin)
    if (command === 'platform' && rest.length === 1)
      return writePlatformFiles(ROOT, rest[0], process.stdin)
    if (command === 'release' && rest.length === 1) return releasePlatformFiles(ROOT, rest[0])
    return refuse('usage')
  }
  run().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      // A fixed reason only: paths and contents are the agent's, never echoed.
      console.error(error instanceof FilesRefused ? `refused: ${error.reason}` : 'failed')
      process.exitCode = error instanceof FilesRefused ? 3 : 1
    },
  )
}
