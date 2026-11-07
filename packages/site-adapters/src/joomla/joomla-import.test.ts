import { createImportPathPolicy, importPolicyOf } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { importDocumentPaths, importExcludedPaths, importTakenPaths } from './fixtures.ts'
import { joomlaImportRules } from './joomla-import.ts'

const rules = joomlaImportRules()
const policy = importPolicyOf(rules)

describe('joomlaImportRules', () => {
  it.each(importTakenPaths)('takes %s', (path) => {
    expect(policy.decide(path, 'file')).toBe('take')
  })

  it.each(importExcludedPaths)('leaves out %s', (path) => {
    expect(policy.decide(path, 'file')).toBe('excluded')
  })

  it.each(importDocumentPaths)('leaves out the document %s', (path) => {
    expect(policy.decide(path, 'file')).toBe('document')
  })

  it('takes a file named as the configuration below the core and extensions, and none elsewhere', () => {
    expect(policy.decide('libraries/vendor/x/configuration.php', 'file')).toBe('take')
    expect(policy.decide('administrator/components/com_x/configuration.php', 'file')).toBe('take')
    expect(policy.decide('templates/x/configuration.php', 'file')).toBe('take')
    expect(policy.decide('backup/configuration.php', 'file')).toBe('excluded')
    expect(policy.decide('site/old/configuration.php', 'file')).toBe('excluded')
    expect(policy.decide('a/b/c/Configuration.PHP', 'file')).toBe('excluded')
  })

  it('leaves out the folders of the installer, the caches and the logs only at the root', () => {
    for (const folder of ['installation', 'cache', 'tmp', 'logs', 'administrator/cache'])
      expect(policy.decide(folder, 'directory')).toBe('excluded')
    for (const folder of ['media/cache', 'components/com_x/tmp', 'plugins/system/logs'])
      expect(policy.decide(folder, 'directory')).toBe('take')
  })

  it('writes the exclude lines into .gitignore under the line of the platform', () => {
    expect(rules.gitignore[0]).toBe(
      '# Managed by Raditi: secrets, caches, backups and logs stay out of git',
    )
    expect(rules.gitignore.slice(1)).toEqual(rules.exclude)
    expect(rules.documentFolders).toEqual(['images/', 'files/'])
    expect(rules.configCopies).toEqual({
      names: ['configuration.php'],
      except: [
        'libraries/',
        'administrator/',
        'api/',
        'components/',
        'modules/',
        'plugins/',
        'templates/',
      ],
      maxDepth: null,
    })
  })

  it('keeps every line in the subset of the policy, with no `[` or `?`', () => {
    for (const line of rules.exclude) {
      expect(() => createImportPathPolicy([line]), line).not.toThrow()
      expect(line).not.toMatch(/[[?]/)
    }
  })

  it('anchors the mask of the configuration to the root', () => {
    // At any depth, without regard to letter case, `configuration*` would cut classes of the core.
    expect(rules.exclude).toContain('/configuration*')
    expect(rules.exclude).not.toContain('configuration*')
    const unanchored = importPolicyOf({
      ...rules,
      exclude: rules.exclude.map((line) => (line === '/configuration*' ? 'configuration*' : line)),
    })
    expect(importTakenPaths.filter((path) => unanchored.decide(path, 'file') !== 'take')).toEqual([
      'libraries/vendor/joomla/application/src/ConfigurationAwareApplicationInterface.php',
      'libraries/vendor/lcobucci/jwt/src/Configuration.php',
      'administrator/components/com_admin/src/Service/HTML/Configuration.php',
      'plugins/system/s3media/vendor/aws/aws-sdk-php/src/Retry/Configuration.php',
      'components/com_foo/src/Service/Configuration.php',
      'components/com_foo/models/configuration.php',
      'templates/x/vendor/league/config/src/Configuration.php',
    ])
  })
})
