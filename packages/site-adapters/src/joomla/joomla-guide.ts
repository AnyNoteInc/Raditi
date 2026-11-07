import type { SiteFacts } from '@repo/domain'

// What the platform rules tell the agent of a site of Joomla (docs/plan/62-site-stacks.md, Т14,
// Т38; docs/plan/62-slices/e3.md, Э3.4). Only `site.generation` picks lines: the version is a
// string from the hosting and never reaches the instructions of a turn.

/** The branches before 4.0, which keep the styles of a template in its own folder. */
const beforeMedia = new Set(['j30', 'j3'])
/** The branches from 4.0, which keep them under `media/templates/`. */
const withMedia = new Set(['j4', 'j5', 'j6'])

const j4Styles =
  '- Styles and scripts of a template live in `media/templates/site/<template>/`, not in its folder. Pages link the minified `.min.css` and `.min.js`, served as ready `.gz` files: change the file the page links and its minified twin; `css/user.css` is the place for your own rules.'
const j3Styles = '- Styles and scripts of a template live in `templates/<template>/css/` and `js/`.'

/** Markdown in English, list items; without a known branch, the lines of both. */
export function joomlaStackGuide(site: SiteFacts): string {
  const generation = site.generation
  const known =
    generation !== undefined && (beforeMedia.has(generation) || withMedia.has(generation))
  return [
    '- Joomla keeps articles, categories, menus, modules and the site name in the database. Files hold templates, their styles and overrides of texts. In the working copy you change files only.',
    '- Template code: `templates/<template>/`: `index.php` and `html/`, which overrides the output of components and modules. A database row says which template a page uses: if your change does not show, the page uses another one.',
    ...(!known || withMedia.has(generation) ? [j4Styles] : []),
    ...(!known || beforeMedia.has(generation) ? [j3Styles] : []),
    '- Texts of the interface: `language/overrides/<tag>.override.ini`, one `KEY="value"` per line.',
    '- A block in the header or the footer is usually a module in the database. A text written into the template next to it makes a second copy that the client cannot edit: say that instead of adding it.',
    '- The core (`libraries/`, `includes/`, `administrator/`, `api/`, `cli/`), components, modules, plugins and `configuration.php` are not yours to change, and they are not in your tree.',
    '- New images go to `images/raditi/`.',
  ].join('\n')
}
