import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { constantOf, EMBEDDED, stackFiles } from '../scripts/stack-files.mjs'

// The orchestrator image holds the workspace packages and not infra/, so the files a preview of a
// stack gets are embedded as constants; infra/<stack>/ stays their one source (docs/plan/62, Т12).
const root = new URL('../../../', import.meta.url)
const run = 'run node packages/site-adapters/scripts/embed-stack-files.mjs'

describe('the embedded files of the stacks', () => {
  it('names a constant after its file', () => {
    expect(constantOf('preview-wp-config.php')).toBe('previewWpConfigPhp')
    expect(constantOf('raditi-content.php')).toBe('raditiContentPhp')
    expect(constantOf('preview-apache.conf')).toBe('previewApacheConf')
    expect(constantOf('preview-php.ini')).toBe('previewPhpIni')
  })

  it('reads the files of a folder by name, without its subfolders and other files', () => {
    const files = stackFiles(root, 'wordpress')
    expect(files.map((file) => file.path)).toEqual([
      'infra/wordpress/preview-apache.conf',
      'infra/wordpress/preview-wp-config.php',
      'infra/wordpress/raditi-content.php',
      'infra/wordpress/raditi-preview.php',
    ])
    // infra/preview holds scripts and a Dockerfile next to its PHP, conf and ini files.
    const preview = stackFiles(root, 'preview').map((file) => file.name)
    expect(preview).toContain('prologue.php')
    expect(preview).not.toContain('Dockerfile')
    expect(preview.every((name) => /\.(?:php|conf|ini)$/.test(name))).toBe(true)
  })

  it('leaves out the files of a subfolder and a folder named like a file', () => {
    // No folder of infra has a subfolder with such a file yet: a root of its own shows the walk
    // stays one level deep and takes files only.
    const temporary = mkdtempSync(join(tmpdir(), 'stack-files-'))
    try {
      const folder = join(temporary, 'infra', 'stack')
      mkdirSync(join(folder, 'sub'), { recursive: true })
      mkdirSync(join(folder, 'dir.conf'))
      writeFileSync(join(folder, 'a.php'), '<?php\n')
      writeFileSync(join(folder, 'sub', 'b.php'), '<?php\n')
      writeFileSync(join(folder, 'README.md'), '# stack\n')
      const files = stackFiles(pathToFileURL(`${temporary}/`), 'stack')
      expect(files).toEqual([
        { name: 'a.php', path: 'infra/stack/a.php', constant: 'aPhp', text: '<?php\n' },
      ])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('sends a mismatch to the script that writes the constants', () => {
    const script = new URL(`../../../${run.replace(/^run node /, '')}`, import.meta.url)
    expect(existsSync(script), run).toBe(true)
    const source = readFileSync(script, 'utf8')
    expect(source).toContain("from './stack-files.mjs'")
    expect(source).toMatch(/Object\.entries\(EMBEDDED\)/)
  })

  for (const [folder, target] of Object.entries(EMBEDDED))
    it(`embeds every file of infra/${folder} in ${target} as it is`, async () => {
      const embedded = (await import(new URL(`../${target}`, import.meta.url).href)) as Record<
        string,
        unknown
      >
      const files = stackFiles(root, folder)
      expect(files.length).toBeGreaterThan(0)
      const problems: string[] = []
      for (const file of files)
        if (!(file.constant in embedded)) problems.push(`${file.path} has no constant`)
        else if (embedded[file.constant] !== file.text) problems.push(`${file.constant} differs`)
      const constants = new Set(files.map((file) => file.constant))
      for (const name of Object.keys(embedded))
        if (!constants.has(name)) problems.push(`${name} has no file in infra/${folder}`)
      expect(problems, run).toEqual([])
    })
})
