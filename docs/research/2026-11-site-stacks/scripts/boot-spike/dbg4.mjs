import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const show = (s) => `${s.uid}:${s.gid} ${(s.mode & 0o7777).toString(8)}`
const variant = process.argv[2]
const h = await fs.open('/files', dirFlags)
console.log(variant, 'before', show(await h.stat()))
await h.chown(0, 33)
if (variant === 'stat-between') await h.stat()
try { await h.chmod(0o1775); console.log('  fchmod right after fchown: ok') } catch (e) { console.log('  fchmod right after fchown:', e.code) }
console.log('  after', show(await h.stat()))
try { await h.chmod(0o1775); console.log('  second fchmod (after a stat): ok', show(await h.stat())) } catch (e) { console.log('  second fchmod:', e.code) }
await h.close()
