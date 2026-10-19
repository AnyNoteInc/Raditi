import {
  mediaLimits,
  WORKING_SET_MAX_BYTES,
  type AgentWorkingSet,
  type MediaRules,
} from '@repo/domain'

import { archivesAndDumps, dataFiles, secretFiles, serverLogs } from './php-hosting.ts'

// The agent's tree and its media for WordPress (docs/plan/53-chat-preview-release.md, Р11,
// Р12). Patterns: the syntax of @repo/domain path-patterns (a trailing `/` — a folder and all
// below it, a leading `/` — from the root, no slash — a name at any depth, `/*` — a root file).

/** The files of the platform in the site: the content plugin and the mu-plugin of a preview. */
export const wordpressPlatformFiles = [
  'wp-content/mu-plugins/raditi-content.php',
  'wp-content/mu-plugins/raditi-preview.php',
] as const

/**
 * Media the agent adds: a folder of its own inside the media library, which it never edits. It
 * is not part of the working set: the folder only grows, so the sandbox would one day exceed its
 * limit with it. The agent adds files there that it does not see; the preview shows them all.
 */
export const WORDPRESS_MEDIA_DIR = 'wp-content/uploads/raditi/'

const workingSet: AgentWorkingSet = {
  include: [
    '/wp-content/themes/',
    '/wp-content/plugins/',
    '/wp-content/mu-plugins/',
    // Files of the root (robots.txt, a verification file); its folders are the core or unknown.
    '/*',
  ],
  exclude: [
    // The core in the root and the configuration with its copies.
    '/wp-*.php',
    '/index.php',
    '/xmlrpc.php',
    '/license.txt',
    '/readme.html',
    ...wordpressPlatformFiles.map((path) => `/${path}`),
    // Dependencies and build output: large, never the agent's to change.
    'node_modules/',
    'vendor/',
    '*.log',
    // What must not reach a model even when a hosting left it next to the code (CLAUDE.md rule 1).
    ...archivesAndDumps,
    ...dataFiles,
    ...secretFiles,
    ...serverLogs,
    // A copy of the configuration at any depth: old/wp-config.php, wp-config.php.save.
    'wp-config*',
  ],
  maxBytes: WORKING_SET_MAX_BYTES,
}

/** Leading bytes, all of which a file of the extension carries (lower-case hex). */
const jpeg = [{ offset: 0, hex: 'ffd8ff' }]
const mediaRules: MediaRules = {
  addOnlyPaths: [WORDPRESS_MEDIA_DIR],
  extensions: {
    jpg: jpeg,
    jpeg,
    png: [{ offset: 0, hex: '89504e470d0a1a0a' }],
    // GIF87a and GIF89a.
    gif: [
      { offset: 0, hex: '47494638' },
      { offset: 5, hex: '61' },
    ],
    webp: [
      { offset: 0, hex: '52494646' },
      { offset: 8, hex: '57454250' },
    ],
    // ISO media with an `avif` or `avis` brand.
    avif: [{ offset: 4, hex: '66747970617669' }],
    mp4: [{ offset: 4, hex: '66747970' }],
    webm: [{ offset: 0, hex: '1a45dfa3' }],
    pdf: [{ offset: 0, hex: '255044462d' }],
    woff2: [{ offset: 0, hex: '774f4632' }],
  },
  // Anything Apache or PHP-FPM may run or read as configuration, and SVG, which a browser runs.
  refusedNameParts: ['.php', '.pht', '.phar', '.htaccess', '.user.ini', '.svg'],
  maxFileBytes: mediaLimits.fileBytes,
}

export function wordpressAgentWorkingSet(): AgentWorkingSet {
  return structuredClone(workingSet)
}

export function wordpressMediaRules(): MediaRules {
  return structuredClone(mediaRules)
}
