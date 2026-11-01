import { writePlatformFiles, ROOT } from '/usr/local/lib/raditi/files.mjs'
try { console.log(await writePlatformFiles(ROOT, '33:33', process.stdin)) } catch (e) { console.log('ERROR', e?.name, e?.reason ?? '', e?.code ?? '', e?.syscall ?? '', e?.path ?? '', e?.message) }
