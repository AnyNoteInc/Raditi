// Planted variants of the spike for the skeptic's checks. Copies the spike (../rebuild, with its
// node_modules) into ../variants/<name>, patches one thing and builds it.
//   focus and menu (for focus-variants.mjs, select-timing.mjs, menu-timing.mjs):
//     base, autofocus (Select gets autoFocus), no-restore (no disableRestoreFocus),
//     no-refocus (the grid does not take the focus back), neither, keep-menu (no close())
//   bugs the spike's check.mjs must catch (run it inside the variant, --only=chromium-desktop):
//     bug-csv (no apostrophe), bug-stale (no «Порядок не обновлён»), bug-tab (Tab stays in the
//     grid on the last cell), bug-nbsp (an ordinary space between thousands)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dirname
const spike = join(here, '..', 'rebuild')
const root = join(here, '..', 'variants')
const G = 'src/table/Grid.tsx'
const patches = {
  base: [],
  autofocus: [[G, '        defaultOpen\n', '        defaultOpen\n        autoFocus\n']],
  'no-restore': [[G, 'MenuProps={{ transitionDuration: 0, disableRestoreFocus: true }}', 'MenuProps={{ transitionDuration: 0 }}']],
  'no-refocus': [[G, '      refocusLater()\n', '', 2]],
  neither: [
    [G, '      refocusLater()\n', '', 2],
    [G, 'MenuProps={{ transitionDuration: 0, disableRestoreFocus: true }}', 'MenuProps={{ transitionDuration: 0 }}'],
  ],
  'keep-menu': [['src/table/Toolbar.tsx', "stock: 'all' }, e.timeStamp)\n              close()\n", "stock: 'all' }, e.timeStamp)\n"]],
  'bug-csv': [['src/table/export.ts', "  return /^[=+\\-@\\t\\r]/.test(cell) ? `'${cell}` : cell", '  return cell']],
  'bug-stale': [['src/table/view.ts', '  const ids = new Set(columns)\n', '  const ids = new Set(columns)\n  if (ids.size >= 0) return false\n']],
  'bug-tab': [[G, 'return // focus leaves the grid', 'return e.preventDefault()']],
  'bug-nbsp': [['src/table/model.ts', "g, ' ')\n  return `${grouped}", "g, ' ')\n  return `${grouped}"]],
}
const files = ['src', 'index.html', 'vite.config.mjs', 'build.mjs', 'tsconfig.json', 'package.json', 'check.mjs', 'serve.mjs', 'fixtures']
for (const [name, list] of Object.entries(patches)) {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const f of files) cpSync(join(spike, f), join(dir, f), { recursive: true })
  if (!existsSync(join(dir, 'node_modules'))) symlinkSync(join('..', '..', 'rebuild', 'node_modules'), join(dir, 'node_modules'))
  for (const [file, from, to, times = 1] of list) {
    const path = join(dir, file)
    const text = readFileSync(path, 'utf8')
    const found = text.split(from).length - 1
    if (found !== times) throw new Error(`${name}: «${from.trim()}» found ${found} times in ${file}, expected ${times}`)
    writeFileSync(path, text.replaceAll(from, to))
  }
  const { buildSpike } = await import(join(dir, 'build.mjs'))
  await buildSpike({ quiet: true })
  console.log(`${name}: built`)
}
