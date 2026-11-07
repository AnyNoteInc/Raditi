import {
  agentWorkingSetSchema,
  assertCandidatePath,
  isForbiddenPath,
  mediaRulesSchema,
  workingSetMatcher,
  type CandidateRules,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { phpServerConfigProtected } from '../php-hosting.ts'
import {
  JOOMLA_MEDIA_DIR,
  joomlaAgentWorkingSet,
  joomlaMediaRules,
  joomlaProtectedPaths,
} from './joomla-working-set.ts'

const set = agentWorkingSetSchema.parse(joomlaAgentWorkingSet())
const inSet = workingSetMatcher(set)
const { addOnlyPaths, ...media } = mediaRulesSchema.parse(joomlaMediaRules())
const rules: CandidateRules = {
  protectedPaths: joomlaProtectedPaths(),
  inWorkingSet: inSet,
  addOnlyPaths,
  media,
}

describe('the Joomla working set (Т38)', () => {
  it.each([
    'templates/x/index.php',
    'templates/x/html/com_content/article/default.php',
    'media/templates/site/x/css/user.css',
    'language/overrides/ru-RU.override.ini',
  ])('gives the agent %s', (path) => {
    expect(inSet(path)).toBe(true)
  })

  it.each([
    'templates/x/configuration.php.bak',
    'templates/x/Configuration.php',
    'plugins/system/x/x.php',
    'images/a.png',
    'media/vendor/a.js',
    'media/system/js/core.js',
    'administrator/language/overrides/ru-RU.override.ini',
    'administrator/templates/atum/index.php',
    'language/ru-RU/ru-RU.ini',
    'configuration.php',
    'index.php',
    'libraries/src/Version.php',
    'templates/x/node_modules/a/index.js',
    'templates/x/backup.sql',
    'templates/x/.env',
    'templates/x/error_log',
  ])('keeps %s out of the sandbox', (path) => {
    expect(inSet(path)).toBe(false)
  })

  it('returns a copy each time', () => {
    joomlaAgentWorkingSet().include.length = 0
    expect(joomlaAgentWorkingSet().include.length).toBeGreaterThan(0)
    joomlaProtectedPaths().length = 0
    expect(joomlaProtectedPaths().length).toBeGreaterThan(0)
  })
})

describe('the paths of a Joomla candidate (Т38, Т42)', () => {
  it('takes a picture the agent adds to its own folder', () => {
    expect(addOnlyPaths).toEqual([JOOMLA_MEDIA_DIR])
    expect(() => assertCandidatePath('images/raditi/a.png', rules)).not.toThrow()
    expect(() => assertCandidatePath('templates/x/index.php', rules)).not.toThrow()
  })

  it.each([
    'images/a.png',
    'configuration.php',
    'libraries/x.php',
    'templates/x/.htaccess',
    'images/raditi/shell.php',
    'images/raditi/.htaccess',
    'media/x.php',
  ])('refuses %s', (path) => {
    expect(() => assertCandidatePath(path, rules)).toThrow()
  })

  it('protects the core, the configuration and the media library', () => {
    // An undo checks its paths against these alone, without the working set: each one counts.
    expect(joomlaProtectedPaths()).toEqual([
      'configuration.php',
      'defines.php',
      'index.php',
      'includes/',
      'libraries/',
      'layouts/',
      'cli/',
      'api/',
      'installation/',
      'administrator/',
      'components/',
      'modules/',
      'plugins/',
      'images/',
      'files/',
      'cache/',
      'tmp/',
      ...phpServerConfigProtected,
    ])
    for (const path of [
      'configuration.php',
      'defines.php',
      'index.php',
      'includes/defines.php',
      'libraries/src/Version.php',
      'layouts/joomla/content/x.php',
      'cli/joomla.php',
      'api/index.php',
      'installation/index.php',
      'administrator/index.php',
      'components/com_x/x.php',
      'modules/mod_x/x.php',
      'plugins/system/x/x.php',
      'images/a.png',
      'files/a.pdf',
      'cache/page/x.php',
      'tmp/x',
      'templates/x/.htaccess',
    ])
      expect(isForbiddenPath(path, rules.protectedPaths), path).toBe(true)
    expect(isForbiddenPath('templates/x/index.php', rules.protectedPaths)).toBe(false)
  })
})
