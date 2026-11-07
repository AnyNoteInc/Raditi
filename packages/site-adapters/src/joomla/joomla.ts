import type { SiteAdapter } from '@repo/domain'
import { noBrowserTasks } from '../no-browser-tasks.ts'
import { joomlaBrowserRequestDenied } from './joomla-browser.ts'
import { joomlaConfigSecrets, joomlaDatabaseSettings, joomlaReadLayout } from './joomla-config.ts'
import { joomlaDatabaseCopyPolicy } from './joomla-db-copy.ts'
import { joomlaStackGuide } from './joomla-guide.ts'
import { joomlaImportRules } from './joomla-import.ts'
import { joomlaPreviewRecipe } from './joomla-preview.ts'
import { JOOMLA_ROOT_MARKERS, joomlaConnection, joomlaRecognition } from './joomla-recognition.ts'
import { joomlaSupport } from './joomla-support.ts'
import { joomlaVerifyPlan } from './joomla-verify.ts'
import { joomlaDriftProbe, joomlaReadVersion } from './joomla-version.ts'
import {
  joomlaAgentWorkingSet,
  joomlaMediaRules,
  joomlaProtectedPaths,
} from './joomla-working-set.ts'

// The adapter of Joomla (docs/plan/62-site-stacks.md, §2.3; docs/plan/62-slices/e3.md, Э3.7): the
// modules of Э3.2–Э3.6 and the recipe, whole, because a stack with open files answers every method
// (the contract of Э2.3). The files are `dev` (Т4): outside production the wizard takes Joomla, in
// production it does not. The panel stays closed until Э8, so the browser tasks refuse, and the
// published content has no plugin (`findSiteContentAdapter` answers null; Т8). No original of a
// public file is taken from the release (Т48).

export const joomlaAdapter: SiteAdapter = {
  stack: 'joomla',
  support: joomlaSupport,
  recognition: joomlaRecognition,
  connection: joomlaConnection,
  readVersion: joomlaReadVersion,
  readLayout: joomlaReadLayout,
  driftProbe: joomlaDriftProbe,
  derivedCopyOf: null,
  rootMarkers: () => [...JOOMLA_ROOT_MARKERS],
  importRules: joomlaImportRules,
  configSecrets: joomlaConfigSecrets,
  databaseSettings: joomlaDatabaseSettings,
  protectedPaths: joomlaProtectedPaths,
  agentWorkingSet: joomlaAgentWorkingSet,
  mediaRules: joomlaMediaRules,
  verify: joomlaVerifyPlan,
  stackGuide: joomlaStackGuide,
  previewRecipe: joomlaPreviewRecipe,
  databaseCopyPolicy: joomlaDatabaseCopyPolicy,
  // The database plan of a release is empty: the content of Joomla changes in its panel (Т36).
  dbOperationKinds: () => [],
  dbSettings: () => [],
  dbPlanGuide: () => '',
  browserRequestDenied: joomlaBrowserRequestDenied,
  ...noBrowserTasks('joomla'),
}
