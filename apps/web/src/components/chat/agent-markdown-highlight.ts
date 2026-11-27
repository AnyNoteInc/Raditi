import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import rehypeHighlight from 'rehype-highlight'

// The colours of the code of the agent's answers: a chunk of its own, loaded by `AgentMarkdown`
// only once an answer has a block of code (docs/plan/96-review-fixes.md, P33.6).

/**
 * The languages a block of code is coloured in (docs/plan/76-agent-instructions.md, И5): what a site
 * of a small business is made of, and the shell. A block names its language (```php); a block of
 * no name or of another language stays plain — nothing is guessed.
 */
const LANGUAGES = {
  bash,
  shell: bash,
  sh: bash,
  css,
  javascript,
  js: javascript,
  json,
  php,
  python,
  sql,
  typescript,
  ts: typescript,
  html: xml,
  xml,
  yaml,
  yml: yaml,
}
export const highlight: [typeof rehypeHighlight, Parameters<typeof rehypeHighlight>[0]] = [
  rehypeHighlight,
  { languages: LANGUAGES, detect: false, plainText: ['text', 'txt', 'plain'] },
]
