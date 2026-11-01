import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
const names = process.argv.slice(2)
const log = (...a) => console.log(...a)
try {
  const st = await fs.lstat('/files'); log('root', st.uid, st.gid, (st.mode & 0o7777).toString(8), 'me', process.getuid())
  const h = await fs.open('/files', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const s1 = await h.stat(); log('fstat', s1.uid, s1.gid, (s1.mode & 0o7777).toString(8))
  try { await h.chown(0, 33); log('chown ok') } catch (e) { log('chown', e.code, e.syscall) }
  const s2 = await h.stat(); log('after chown', s2.uid, s2.gid, (s2.mode & 0o7777).toString(8))
  try { await h.chmod(0o1775); log('chmod ok') } catch (e) { log('chmod', e.code, e.syscall) }
  const s3 = await h.stat(); log('after chmod', s3.uid, s3.gid, (s3.mode & 0o7777).toString(8))
  try { const f = await fs.open('/files/x.tmp', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444); await f.write(Buffer.from('a')); await f.chmod(0o444); await f.close(); log('file ok'); await fs.rename('/files/x.tmp', '/files/x'); log('rename ok') } catch (e) { log('file', e.code, e.syscall, e.path) }
  try { await fs.mkdir('/files/sub', { mode: 0o700 }); log('mkdir ok') } catch (e) { log('mkdir', e.code) }
  const proc = '/proc/self/fd/' + h.fd
  try { log('readlink', await fs.readlink(proc)) } catch (e) { log('readlink', e.code) }
  try { await fs.mkdir(proc + '/sub2', { mode: 0o700 }); log('mkdir via proc fd ok') } catch (e) { log('mkdir via proc fd', e.code) }
  try { await fs.mkdir(proc + '/.', { mode: 0o700 }) } catch (e) { log('mkdir . via proc', e.code) }
  await h.close()
} catch (e) { log('ERR', e.code, e.syscall, e.path, e.message) }
