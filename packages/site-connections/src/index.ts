// Site connection adapters (spec §12, docs/plan/39-site-connection-wizard.md): where the files of a
// site come from — SFTP over SSH or FTP — and the DNS lookup every check pins its address with. The
// database inspectors are at `@repo/site-connections/databases`, the services the web transport is
// given at `@repo/site-connections/services`, the test servers at `@repo/site-connections/testing`.
export { createHostLookup } from './lookup.ts'
export { ftpSource } from './sources/ftp.ts'
export { offeredSourceKinds, siteSource } from './sources/registry.ts'
export { sftpSource } from './sources/sftp.ts'
