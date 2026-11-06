// The list of the files of a version as the section «Терминал» draws it: folders, then files, each
// by name. Pure: the paths come from the server, the tree is built here.

export interface SiteFileNode {
  kind: 'file'
  name: string
  path: string
  size: number
}

export interface SiteFolderNode {
  kind: 'folder'
  name: string
  /** '' — the root. */
  path: string
  children: SiteTreeNode[]
  /** Files under it, at any depth. */
  files: number
}

export type SiteTreeNode = SiteFileNode | SiteFolderNode

const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

function sortFolder(folder: SiteFolderNode): void {
  folder.children.sort((a, b) =>
    a.kind === b.kind ? byName.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1,
  )
  for (const child of folder.children) if (child.kind === 'folder') sortFolder(child)
}

/** The tree of `files`, paths of git: `a/b/c.php`. */
export function siteFileTree(files: ReadonlyArray<{ path: string; size: number }>): SiteFolderNode {
  const root: SiteFolderNode = { kind: 'folder', name: '', path: '', children: [], files: 0 }
  const folders = new Map<string, SiteFolderNode>([['', root]])
  for (const file of files) {
    const parts = file.path.split('/')
    let parent = root
    parent.files++
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join('/')
      let folder = folders.get(path)
      if (!folder) {
        folder = { kind: 'folder', name: parts[depth]!, path, children: [], files: 0 }
        folders.set(path, folder)
        parent.children.push(folder)
      }
      folder.files++
      parent = folder
    }
    parent.children.push({ kind: 'file', name: parts.at(-1)!, path: file.path, size: file.size })
  }
  sortFolder(root)
  return root
}

/** The lines of a text as the viewer numbers them: a final line break opens no empty line. */
export function viewerLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}
