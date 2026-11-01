// rules.mjs <cms>: .gitignore of an import, the shared lists taken from the product's php-hosting.ts.
const R = '<repo>'
const { archivesAndDumps, dataFiles, secretFiles, serverLogs, phpServerConfigFiles } = await import(`${R}/packages/site-adapters/src/php-hosting.ts`)
const anchored = (l) => l.map((p) => (p.startsWith('/') ? p : `/${p}`))
const shared = ['node_modules/', '*.log', ...serverLogs, ...archivesAndDumps, ...dataFiles, ...secretFiles]
const cms = {
  // joomla.md:865, anchored where the report's list reads as a path of the root.
  joomla: [...anchored(['configuration.php', 'defines.php', 'installation/', 'cache/', 'administrator/cache/', 'tmp/', 'administrator/logs/', 'logs/', 'kickstart.php', ...phpServerConfigFiles]), 'configuration.php*', 'configuration.bak', 'configuration_old.php', '*.jps', '*.j[0-9][0-9]'],
  // opencart.md:816
  opencart: [...anchored(['config.php', '*/config.php', 'install/', 'image/cache/', 'system/storage/cache/', 'system/storage/logs/', 'system/storage/session/', 'system/storage/upload/', 'system/storage/download/', 'system/storage/backup/', 'system/storage/marketplace/', 'vqmod/vqcache/', 'vqmod/logs/', 'vqmod/*.cache', ...phpServerConfigFiles])],
  // modx.md:877
  modx: [...anchored(['core/config/', 'core/cache/', 'core/packages/', 'core/export/', 'core/import/', 'setup/', '_build/', '_backup/', '_data/', '_packages/', '.gitify', ...phpServerConfigFiles]), 'config.inc.php*'],
}
const list = cms[process.argv[2]]
if (!list) { console.error('unknown cms'); process.exit(64) }
console.log([...list, ...shared].join('\n'))
