import { describe, expect, it } from 'vitest'

import { siteFileTree, viewerLines, type SiteFolderNode } from './site-files-tree'

const names = (folder: SiteFolderNode) => folder.children.map((node) => node.name)

describe('siteFileTree', () => {
  it('builds folders from the paths of git, folders first and each by name', () => {
    const root = siteFileTree([
      { path: 'index.php', size: 400 },
      { path: 'wp-content/themes/kadence/style.css', size: 10 },
      { path: 'wp-content/plugins/b/b.php', size: 3 },
      { path: 'wp-content/plugins/a10/a.php', size: 2 },
      { path: 'wp-content/plugins/a9/a.php', size: 1 },
      { path: '.htaccess', size: 5 },
    ])
    expect(root.files).toBe(6)
    expect(names(root)).toEqual(['wp-content', '.htaccess', 'index.php'])
    const content = root.children[0] as SiteFolderNode
    expect(content).toMatchObject({ kind: 'folder', path: 'wp-content', files: 4 })
    expect(names(content)).toEqual(['plugins', 'themes'])
    // Numbers in names count as numbers: a9 before a10.
    expect(names(content.children[0] as SiteFolderNode)).toEqual(['a9', 'a10', 'b'])
    expect(
      ((content.children[1] as SiteFolderNode).children[0] as SiteFolderNode).children[0],
    ).toEqual({
      kind: 'file',
      name: 'style.css',
      path: 'wp-content/themes/kadence/style.css',
      size: 10,
    })
  })
})

describe('viewerLines', () => {
  it('numbers the lines of a text, a final line break opening none', () => {
    expect(viewerLines('a\nb\n')).toEqual(['a', 'b'])
    expect(viewerLines('a\r\nb')).toEqual(['a', 'b'])
    expect(viewerLines('')).toEqual([''])
    expect(viewerLines('\n')).toEqual([''])
  })
})
