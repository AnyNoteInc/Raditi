import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | noFollow
const show = (s) => `${s.uid}:${s.gid} ${(s.mode & 0o7777).toString(8)}`
const step = async (name, f) => { try { const r = await f(); console.log('ok  ', name, r ?? ''); return r } catch (e) { console.log('FAIL', name, e.code, e.syscall) ; return undefined } }
const h = await fs.open('/files', dirFlags)
console.log('root', show(await h.stat()), 'euid', process.geteuid(), 'gid', process.getegid())
await step('chown dir 0:33', () => h.chown(0, 33))
await step('stat', async () => show(await h.stat()))
await step('chmod dir 1775', () => h.chmod(0o1775))
await step('stat', async () => show(await h.stat()))
const under = (n) => `/proc/self/fd/${h.fd}/${n}`
// the same create as writePlatformFiles: through the descriptor of the folder
const f = await step('open file via proc fd 0444', () => fs.open(under('.raditi-1'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o444))
if (f) { console.log('     new file', show(await f.stat()), 'dir now', show(await h.stat())); await step('write', () => f.write(Buffer.from('x'))); await step('fchmod 444 via handle', () => f.chmod(0o444)); await f.close() }
const p = await step('open file by path 0444', () => fs.open('/files/.raditi-2', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o444))
if (p) { console.log('     new file', show(await p.stat())); await step('fchmod via handle', () => p.chmod(0o444)); await p.close() }
const q = await step('open file by path, no NOFOLLOW/NONBLOCK', () => fs.open('/files/.raditi-3', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444))
if (q) { console.log('     new file', show(await q.stat())); await step('fchmod via handle', () => q.chmod(0o444)); await q.close() }
await step('chmod by path', () => fs.chmod('/files/.raditi-2', 0o444))
await h.close()
