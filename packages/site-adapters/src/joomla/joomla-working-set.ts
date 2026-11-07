import { WORKING_SET_MAX_BYTES, type AgentWorkingSet, type MediaRules } from '@repo/domain'

import { phpMediaRules } from '../php/media.ts'
import {
  archivesAndDumps,
  dataFiles,
  phpServerConfigProtected,
  secretFiles,
  serverLogs,
} from '../php-hosting.ts'

// The agent's tree, the paths it never touches and its media on a site of Joomla
// (docs/plan/62-site-stacks.md, Т38, Т42; docs/plan/62-slices/e3.md, Э3.4). Patterns: the syntax
// of `protectedPaths` (wordpress.ts) and of the path patterns of @repo/domain.

/**
 * Media the agent adds: a folder of its own inside the images of the site, which it never edits
 * and is never given (the folder only grows). The rest of `images/` stays protected.
 */
export const JOOMLA_MEDIA_DIR = 'images/raditi/'

/**
 * The configuration, the core, the extensions, the media library and the caches. `media/` and
 * `language/` are not here: outside the working set a path is refused anyway (`assertCandidatePath`,
 * the second line of the release), and the agent needs `media/templates/` and `language/overrides/`.
 */
const protectedPaths = [
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
]

/**
 * The templates of the site, their styles and scripts (4.0 and later keep them under `media/`) and
 * the overrides of texts; nothing of the core, the extensions or the configuration. The overrides
 * of the administrator's texts are not the agent's (Т38).
 */
const workingSet: AgentWorkingSet = {
  include: ['/templates/', '/media/templates/', '/language/overrides/'],
  exclude: [
    // Dependencies and build output: large, never the agent's to change.
    'node_modules/',
    'vendor/',
    '*.log',
    // What must not reach a model even when a hosting left it next to the code (CLAUDE.md rule 1).
    ...archivesAndDumps,
    ...dataFiles,
    ...secretFiles,
    ...serverLogs,
    // A copy of the configuration at any depth: templates/x/configuration.php.bak.
    'configuration*',
  ],
  maxBytes: WORKING_SET_MAX_BYTES,
}

export function joomlaProtectedPaths(): string[] {
  return [...protectedPaths]
}

export function joomlaAgentWorkingSet(): AgentWorkingSet {
  return structuredClone(workingSet)
}

export function joomlaMediaRules(): MediaRules {
  return phpMediaRules(JOOMLA_MEDIA_DIR)
}
