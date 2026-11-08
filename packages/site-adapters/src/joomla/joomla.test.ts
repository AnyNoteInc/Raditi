import { describe, expect, it } from 'vitest'
import { getSiteAdapter } from '../registry.ts'
import { joomlaBrowserRequestDenied } from './joomla-browser.ts'
import { joomlaConfigSecrets, joomlaDatabaseSettings, joomlaReadLayout } from './joomla-config.ts'
import { joomlaDatabaseCopyPolicy } from './joomla-db-copy.ts'
import { joomlaStackGuide } from './joomla-guide.ts'
import { joomlaImportRules } from './joomla-import.ts'
import { joomlaPreviewRecipe } from './joomla-preview.ts'
import { joomlaConnection, joomlaRecognition } from './joomla-recognition.ts'
import { joomlaSupport } from './joomla-support.ts'
import { joomlaVerifyPlan } from './joomla-verify.ts'
import { joomlaDriftProbe, joomlaReadVersion } from './joomla-version.ts'
import {
  joomlaAgentWorkingSet,
  joomlaMediaRules,
  joomlaProtectedPaths,
} from './joomla-working-set.ts'
import { joomlaContractFixture } from './fixtures.ts'
import { joomlaAdapter } from './joomla.ts'
import { previewConfigurationPhp } from './preview-files.ts'

// The adapter of Joomla is built from the modules of Э3.2–Э3.7 (docs/plan/62-slices/e3.md, Э3.7).
// The contract set calls each slot but cannot tell a slot of another stack that happens to accept
// the fixture, so the slots are checked here by reference.

describe('joomlaAdapter', () => {
  it('is the adapter the registry gives for Joomla', () => {
    expect(getSiteAdapter('joomla')).toBe(joomlaAdapter)
  })

  it('fills every slot with the module of Joomla', () => {
    expect(joomlaAdapter).toMatchObject({
      stack: 'joomla',
      support: joomlaSupport,
      recognition: joomlaRecognition,
      connection: joomlaConnection,
      derivedCopyOf: null,
    })
    expect(joomlaAdapter.readVersion).toBe(joomlaReadVersion)
    expect(joomlaAdapter.readLayout).toBe(joomlaReadLayout)
    expect(joomlaAdapter.driftProbe).toBe(joomlaDriftProbe)
    expect(joomlaAdapter.importRules).toBe(joomlaImportRules)
    expect(joomlaAdapter.configSecrets).toBe(joomlaConfigSecrets)
    expect(joomlaAdapter.databaseSettings).toBe(joomlaDatabaseSettings)
    expect(joomlaAdapter.protectedPaths).toBe(joomlaProtectedPaths)
    expect(joomlaAdapter.agentWorkingSet).toBe(joomlaAgentWorkingSet)
    expect(joomlaAdapter.mediaRules).toBe(joomlaMediaRules)
    expect(joomlaAdapter.verify).toBe(joomlaVerifyPlan)
    expect(joomlaAdapter.stackGuide).toBe(joomlaStackGuide)
    expect(joomlaAdapter.previewRecipe).toBe(joomlaPreviewRecipe)
    expect(joomlaAdapter.databaseCopyPolicy).toBe(joomlaDatabaseCopyPolicy)
    expect(joomlaAdapter.browserRequestDenied).toBe(joomlaBrowserRequestDenied)
  })

  it('writes the configuration.php of Joomla into a preview', () => {
    expect(joomlaAdapter.previewRecipe(joomlaContractFixture.site).generatedFiles).toEqual([
      { path: 'configuration.php', content: previewConfigurationPhp },
    ])
  })

  it('takes no original of a public file (Т48) and has an empty database plan (Т36)', () => {
    expect('publicOriginals' in joomlaAdapter).toBe(false)
    const site = joomlaContractFixture.site
    expect(joomlaAdapter.dbOperationKinds(site)).toEqual([])
    expect(joomlaAdapter.dbSettings(site)).toEqual([])
    expect(joomlaAdapter.dbPlanGuide(site)).toBe('')
  })

  it('refuses the tasks in the browser until its panel opens (Э8)', () => {
    expect(() => joomlaAdapter.browserGuide()).toThrow(/not implemented|NOT_IMPLEMENTED/)
  })
})
