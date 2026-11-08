// What embed-stack-files.mjs embeds and where (docs/plan/62-site-stacks.md, Т12): the files of
// infra/<stack>/ a preview of the stack gets, as string constants of the adapter. Pure: importing
// it writes nothing and loads no formatter, so stack-files.test.ts reads it as it is.
import { readdirSync, readFileSync } from 'node:fs'
import { URL } from 'node:url'

/** The folder of infra and the file of its constants. A new stack is a new line. */
export const EMBEDDED = Object.freeze({
  wordpress: 'src/wordpress-preview-files.ts',
  joomla: 'src/joomla/preview-files.ts',
  // The files a preview of every stack but WordPress takes from infra/preview (Т11, Т21).
  preview: 'src/php/preview-files.ts',
})

const EMBEDDABLE = /\.(?:php|conf|ini)$/

/** `preview-wp-config.php` → `previewWpConfigPhp`. */
export const constantOf = (name) => name.replace(/[-.](.)/g, (_, c) => c.toUpperCase())

/** The files of one folder of infra by name, without its subfolders. */
export function stackFiles(rootUrl, folder) {
  const directory = new URL(`infra/${folder}/`, rootUrl)
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && EMBEDDABLE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      path: `infra/${folder}/${name}`,
      constant: constantOf(name),
      text: readFileSync(new URL(name, directory), 'utf8'),
    }))
}
