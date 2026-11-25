import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

// The languages of a block of code in an answer (docs/plan/76-agent-instructions.md, И5; docs/plan/
// 91-chat-diagrams.md, Д6): one table of the names a block may give — the grammar it is coloured
// by and the name people know it by. A block names its language (```php); a block of no name or of
// a name not here stays plain — nothing is guessed. Diagrams have a name and no grammar: the server
// draws them.

type Grammar = typeof bash

const CODE_LANGUAGES: Readonly<Record<string, { grammar?: Grammar; name: string }>> = {
  bash: { grammar: bash, name: 'Bash' },
  sh: { grammar: bash, name: 'Shell' },
  shell: { grammar: bash, name: 'Shell' },
  zsh: { grammar: bash, name: 'Shell' },
  powershell: { grammar: powershell, name: 'PowerShell' },
  ps1: { grammar: powershell, name: 'PowerShell' },
  javascript: { grammar: javascript, name: 'JavaScript' },
  js: { grammar: javascript, name: 'JavaScript' },
  jsx: { grammar: javascript, name: 'JSX' },
  typescript: { grammar: typescript, name: 'TypeScript' },
  ts: { grammar: typescript, name: 'TypeScript' },
  tsx: { grammar: typescript, name: 'TSX' },
  json: { grammar: json, name: 'JSON' },
  html: { grammar: xml, name: 'HTML' },
  xml: { grammar: xml, name: 'XML' },
  svg: { grammar: xml, name: 'SVG' },
  css: { grammar: css, name: 'CSS' },
  scss: { grammar: scss, name: 'SCSS' },
  less: { grammar: less, name: 'Less' },
  php: { grammar: php, name: 'PHP' },
  python: { grammar: python, name: 'Python' },
  py: { grammar: python, name: 'Python' },
  sql: { grammar: sql, name: 'SQL' },
  yaml: { grammar: yaml, name: 'YAML' },
  yml: { grammar: yaml, name: 'YAML' },
  ini: { grammar: ini, name: 'INI' },
  toml: { grammar: ini, name: 'TOML' },
  go: { grammar: go, name: 'Go' },
  java: { grammar: java, name: 'Java' },
  kotlin: { grammar: kotlin, name: 'Kotlin' },
  kt: { grammar: kotlin, name: 'Kotlin' },
  c: { grammar: c, name: 'C' },
  cpp: { grammar: cpp, name: 'C++' },
  csharp: { grammar: csharp, name: 'C#' },
  cs: { grammar: csharp, name: 'C#' },
  rust: { grammar: rust, name: 'Rust' },
  rs: { grammar: rust, name: 'Rust' },
  ruby: { grammar: ruby, name: 'Ruby' },
  rb: { grammar: ruby, name: 'Ruby' },
  swift: { grammar: swift, name: 'Swift' },
  diff: { grammar: diff, name: 'Diff' },
  patch: { grammar: diff, name: 'Diff' },
  dockerfile: { grammar: dockerfile, name: 'Dockerfile' },
  docker: { grammar: dockerfile, name: 'Dockerfile' },
  nginx: { grammar: nginx, name: 'nginx' },
  markdown: { grammar: markdown, name: 'Markdown' },
  md: { grammar: markdown, name: 'Markdown' },
  graphql: { grammar: graphql, name: 'GraphQL' },
  mermaid: { name: 'Mermaid' },
  plantuml: { name: 'PlantUML' },
  puml: { name: 'PlantUML' },
  uml: { name: 'PlantUML' },
}

/** The grammars by the names a block may give, for `rehype-highlight`. */
export const highlightLanguages: Record<string, Grammar> = Object.fromEntries(
  Object.entries(CODE_LANGUAGES).flatMap(([alias, { grammar }]) =>
    grammar ? [[alias, grammar]] : [],
  ),
)

/** The name people know a language by; another is shown as its block names it. */
export function languageName(language: string): string {
  return CODE_LANGUAGES[language.toLowerCase()]?.name ?? language
}
