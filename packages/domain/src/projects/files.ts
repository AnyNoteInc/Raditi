import { z } from 'zod'

import {
  attachmentFileName,
  attachmentLimits,
  attachmentTypes,
  fileSignatureMatches,
  type FileSignature,
} from '../attachments/rules.ts'
import { badRequest, DomainError } from '../errors.ts'
import { projectTextHasSecret } from './errors.ts'
import { projectLimits } from './limits.ts'
import { secretInContent } from './text.ts'

// The files and texts of the context of a project (docs/plan/84-projects.md, ПР8; slice 84.8):
// which files are taken, how a path of a folder is cleaned, where the object lies, how much room
// a project and a workspace have, and how a text the client wrote becomes a file. Pure rules: web,
// the procedures and core read the same ones. A file comes before its project, as an attachment
// before its chat: `projectFile.start` announces it without a project, its bytes go through web
// into raditi-inbox under `projects/<workspaceId>/<fileId>`, and a project takes it (`bind`) —
// a file nobody took is collected after a day.

/** The lengths of a path; the rest of the bounds are projectLimits. */
export const projectFileLimits = Object.freeze({
  /** The parts of a path of a folder, the file's own name among them (ПР8: «до 8 уровней»). */
  pathParts: 8,
  /** A path as `project_files.name` keeps it, in characters. */
  pathChars: 255,
  /** A path as the browser sends it, before cleaning. */
  rawPathLength: 2048,
  /** «Добавить текстовое содержимое»: the characters of its title. */
  titleChars: 120,
  /** How many «(2)», «(3)»… a name tries before a project refuses the file. */
  nameVariants: 100,
})

export type ProjectFileKind = 'image' | 'document' | 'text'

interface ProjectFileTypeEntry {
  readonly mime: string
  /** Lowercase, without the dot. No two types share an extension. */
  readonly extensions: readonly string[]
  /** What the client reads. */
  readonly label: string
  readonly kind: ProjectFileKind
  readonly signature: FileSignature
}

// The source code an agent reads as text: one type for all of it, told by the extension.
const SOURCE_EXTENSIONS = [
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'vue',
  'svelte',
  'scss',
  'sass',
  'less',
  'py',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'sql',
  'sh',
  'bash',
  'zsh',
  'toml',
  'ini',
  'lua',
  'pl',
  'r',
  'dart',
  'scala',
  'graphql',
  'gql',
  'proto',
  'tf',
  'twig',
  'tpl',
] as const

/**
 * The files a project takes — and nothing else (ПР8): the types of attachments, and text in UTF-8:
 * Markdown, JSON, HTML, XML, YAML, CSS and source code. `.env`, `.pem` and `.key` are not on the
 * list, and neither is anything else that is not.
 */
export const projectFileTypes: readonly ProjectFileTypeEntry[] = Object.freeze(
  [
    ...attachmentTypes.map((type) => ({
      mime: type.mime,
      extensions: type.extensions,
      label: type.label,
      kind: (type.signature === 'text' ? 'text' : type.kind) as ProjectFileKind,
      signature: type.signature,
    })),
    { mime: 'text/markdown', extensions: ['md', 'markdown'], label: 'Текст Markdown' },
    { mime: 'application/json', extensions: ['json'], label: 'Данные JSON' },
    { mime: 'text/html', extensions: ['html', 'htm'], label: 'Страница HTML' },
    { mime: 'application/xml', extensions: ['xml'], label: 'Данные XML' },
    { mime: 'application/yaml', extensions: ['yaml', 'yml'], label: 'Данные YAML' },
    { mime: 'text/css', extensions: ['css'], label: 'Стили CSS' },
    { mime: 'text/x-source', extensions: SOURCE_EXTENSIONS, label: 'Исходный код' },
  ].map((type) =>
    'kind' in type ? type : { ...type, kind: 'text' as const, signature: 'text' as const },
  ),
)
export type ProjectFileType = (typeof projectFileTypes)[number]

export const projectFileMimeTypes: readonly string[] = Object.freeze(
  projectFileTypes.map((type) => type.mime),
)

/** The `accept` of the file inputs of «Контекст»: the extensions, comma-separated. */
export const projectFileAcceptAttribute = projectFileTypes
  .flatMap((type) => type.extensions.map((extension) => `.${extension}`))
  .join(',')

const normalMime = (mime: string) => mime.split(';', 1)[0]!.trim().toLowerCase()

/** The listed type of a declared MIME type, or null. */
export function projectFileTypeOf(mime: string): ProjectFileType | null {
  const wanted = normalMime(mime)
  return projectFileTypes.find((type) => type.mime === wanted) ?? null
}

const EXTENSION = /\.([\p{L}\p{N}]{1,16})$/u

/** The listed type of a path, by the extension of its last part; null — not taken. */
export function projectFileTypeByName(path: string): ProjectFileType | null {
  const extension = EXTENSION.exec(path.split('/').at(-1) ?? '')?.[1]?.toLowerCase()
  if (extension === undefined) return null
  return projectFileTypes.find((type) => type.extensions.includes(extension)) ?? null
}

/**
 * Why a file of a project is refused:
 * - `type_not_allowed` — the type is not on the list, or the name does not end in its extension;
 * - `content_mismatch` — the first bytes are not those of a file of this type;
 * - `text_encoding` — a text that is not UTF-8 (a NUL byte or an invalid sequence);
 * - `empty` — no bytes, or a path with nothing left after cleaning;
 * - `too_large` — over `projectLimits.fileBytes`;
 * - `path_invalid` — `..`, more than eight parts or longer than 255 characters;
 * - `has_secret` — a text that holds a password or a key (secretInContent).
 */
export const projectFileRefusals = [
  'type_not_allowed',
  'content_mismatch',
  'text_encoding',
  'empty',
  'too_large',
  'path_invalid',
  'has_secret',
] as const
export type ProjectFileRefusal = (typeof projectFileRefusals)[number]

/**
 * Whether the first bytes of a file are what its declared type says, as for an attachment: the
 * declared type must be listed, the bytes are checked against it, never guessed.
 */
export function sniffProjectFile(
  firstBytes: Uint8Array,
  declaredMime: string,
):
  | { ok: true; type: ProjectFileType }
  | {
      ok: false
      reason: Extract<
        ProjectFileRefusal,
        'type_not_allowed' | 'content_mismatch' | 'text_encoding' | 'empty'
      >
    } {
  const type = projectFileTypeOf(declaredMime)
  if (type === null) return { ok: false, reason: 'type_not_allowed' }
  if (firstBytes.byteLength === 0) return { ok: false, reason: 'empty' }
  if (fileSignatureMatches(type.signature, firstBytes)) return { ok: true, type }
  return { ok: false, reason: type.signature === 'text' ? 'text_encoding' : 'content_mismatch' }
}

/** A whole text file in UTF-8 without a NUL byte; null — it is not one. */
export function projectTextOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------------------------

/**
 * The path a file is kept and put into the sandbox under (`/workspace/project/<path>`), from the
 * name or the relative path of a folder the browser gave: separators of both kinds, empty parts
 * and `.` dropped, every part cleaned as the name of an attachment (attachmentFileName: no control,
 * invisible or reserved characters, no dots or spaces at the ends — so no hidden part), at most
 * eight parts and 255 characters. null — `..` anywhere, nothing left, or too long.
 */
export function projectFilePath(raw: string): string | null {
  if (raw.length > projectFileLimits.rawPathLength) return null
  const parts = raw.split(/[\\/]/u).filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.length > projectFileLimits.pathParts) return null
  if (parts.some((part) => part.trim() === '..')) return null
  const clean: string[] = []
  for (const part of parts) {
    // A hidden part loses its dots first: `.github` is a folder `github`, `.env` a name `env`.
    const name = attachmentFileName(part.replace(/^[\s.]+/u, ''))
    if (name === null) return null
    clean.push(name)
  }
  const path = clean.join('/')
  return [...path].length <= projectFileLimits.pathChars ? path : null
}

/** Why a raw path is refused, or null: `empty` for nothing left, `path_invalid` otherwise. */
export function projectFilePathRefusal(raw: string): ProjectFileRefusal | null {
  if (projectFilePath(raw) !== null) return null
  const parts = raw.split(/[\\/]/u).filter((part) => part !== '' && part !== '.')
  return parts.length === 0 ||
    parts.every((part) => attachmentFileName(part.replace(/^[\s.]+/u, '')) === null)
    ? 'empty'
    : 'path_invalid'
}

/** «Брендбук.pdf» → «Брендбук (2).pdf»; the folders of the path stay. */
export function projectFileNameVariant(path: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const folder = slash < 0 ? '' : path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  return `${folder}${name.slice(0, name.length - extension.length)} (${n})${extension}`
}

/** Two paths that cannot lie side by side: the same, or one is a folder of the other. */
const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

/**
 * The path a file takes in a project that already holds `taken`: its own, else «(2)», «(3)»… of
 * its name; null — none is free (or a folder of the path is a file of the project).
 */
export function freeProjectFilePath(path: string, taken: Iterable<string>): string | null {
  const names = [...taken]
  for (let n = 1; n <= projectFileLimits.nameVariants; n++) {
    const candidate = n === 1 ? path : projectFileNameVariant(path, n)
    if ([...candidate].length > projectFileLimits.pathChars) return null
    if (!names.some((name) => clash(candidate, name))) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The object, the room, the text
// ---------------------------------------------------------------------------------------------

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The key of a file of a project in raditi-inbox: `projects/<workspaceId>/<fileId>` (ПР8). */
export function projectFileKey(workspaceId: string, fileId: string): string {
  if (!ID.test(workspaceId) || !ID.test(fileId))
    throw badRequest('A key of a project file is built from two lowercase ids')
  return `projects/${workspaceId}/${fileId}`
}

/** `uploading` — announced, the bytes on their way; `ready` — stored and checked. */
export const projectFileStatuses = ['uploading', 'ready'] as const
export type ProjectFileStatus = (typeof projectFileStatuses)[number]

/** A file of a project the rules refuse; `reason` picks the client's words. */
export const projectFileRefused = (reason: ProjectFileRefusal): DomainError =>
  new DomainError('PROJECT_FILE_REFUSED', `The project file is refused: ${reason}`, 400, { reason })

/** Not there, gone, or someone else's. */
export const projectFileNotFound = (): DomainError =>
  new DomainError('PROJECT_FILE_NOT_FOUND', 'No such file of the project', 404)

/** The file is not stored yet, or its day to be taken is over. */
export const projectFileNotReady = (): DomainError =>
  new DomainError('PROJECT_FILE_NOT_READY', 'A file of the project is not ready', 409)

export const projectFilesTooMany = (): DomainError =>
  new DomainError('PROJECT_FILES_TOO_MANY', 'The project holds its maximum of files', 409)

/** `scope` says whose room is full: the project's (100 MiB) or the workspace's (1 GiB). */
export const projectSpaceFull = (scope: 'project' | 'workspace'): DomainError =>
  new DomainError('PROJECT_SPACE_FULL', `No room left in the ${scope}`, 409, { scope })

/** The room taken: of the project the file goes to (if known) and of its workspace. */
export interface ProjectRoom {
  workspaceBytes: number
  /** Absent — the file has no project yet: only the room of the workspace is checked. */
  project?: { files: number; bytes: number }
}

/** The refusal of adding `files` files of `bytes` bytes to `room`, or null (ПР8, §4.7). */
export function projectRoomRefusal(
  room: ProjectRoom,
  adding: { files: number; bytes: number },
): DomainError | null {
  if (room.project) {
    if (room.project.files + adding.files > projectLimits.filesPerProject)
      return projectFilesTooMany()
    if (room.project.bytes + adding.bytes > projectLimits.projectBytes)
      return projectSpaceFull('project')
  }
  if (room.workspaceBytes + adding.bytes > projectLimits.workspaceBytes)
    return projectSpaceFull('workspace')
  return null
}

/** «Занято N % места»: of the project, whole percent, at least 1 once anything is there. */
export function projectRoomPercent(bytes: number): number {
  if (bytes <= 0) return 0
  return Math.min(100, Math.max(1, Math.round((bytes / projectLimits.projectBytes) * 100)))
}

/** The id of a file of a project, as PostgreSQL prints it. */
export const projectFileIdSchema = z.uuid().transform((id) => id.toLowerCase())

/** Ids of files, each once: what `project.create` and `projectFile.bind` take. */
export const projectFileIdsSchema = z
  .array(projectFileIdSchema)
  .max(projectLimits.filesPerProject)
  .refine((ids) => new Set(ids).size === ids.length, 'expected distinct files')

/** What `projectFile.start` takes as the browser sends it; the rules are checked after. */
export const projectFileStartInputSchema = z.strictObject({
  name: z.string().max(projectFileLimits.rawPathLength),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  type: z.string().max(255),
})

/**
 * A file the browser announced, by the rules: its clean path and its listed type, which must be
 * the type of the path's extension; a refusal names why.
 */
export function projectFileOf(input: { name: string; size: number; type: string }): {
  path: string
  type: ProjectFileType
  size: number
} {
  const path = projectFilePath(input.name)
  if (path === null) throw projectFileRefused(projectFilePathRefusal(input.name) ?? 'path_invalid')
  const type = projectFileTypeOf(input.type)
  if (type === null || projectFileTypeByName(path)?.mime !== type.mime)
    throw projectFileRefused('type_not_allowed')
  if (input.size < 1) throw projectFileRefused('empty')
  if (input.size > projectLimits.fileBytes) throw projectFileRefused('too_large')
  return { path, type, size: input.size }
}

/** «Добавить текстовое содержимое»: what the procedure takes. */
export const projectTextInputSchema = z.strictObject({
  title: z.string().max(projectFileLimits.titleChars * 4),
  text: z.string().max(projectLimits.textChars * 2),
})

/**
 * A text the client wrote, as the file it is kept as (ПР8): the title cleaned into one name with
 * `.md` (no folder: a slash becomes `_`), the text in UTF-8, at most 100 000 characters, without a
 * secret (`secretInContent`, PROJECT_TEXT_HAS_SECRET).
 */
export function projectTextFileOf(input: { title: string; text: string }): {
  path: string
  bytes: Uint8Array
} {
  const title = [...input.title.trim().replace(/[\\/]/gu, '_')]
    .slice(0, projectFileLimits.titleChars)
    .join('')
  const base = attachmentFileName(title.replace(/\.md$/iu, ''))
  if (base === null) throw projectFileRefused('empty')
  const text = input.text
  if (text.trim() === '') throw projectFileRefused('empty')
  if ([...text].length > projectLimits.textChars) throw projectFileRefused('too_large')
  if (secretInContent(text)) throw projectTextHasSecret()
  const path = attachmentFileName(`${base}.md`)
  if (path === null) throw projectFileRefused('empty')
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > projectLimits.fileBytes) throw projectFileRefused('too_large')
  return { path, bytes }
}

/** The bytes the first look of the upload reads, as for an attachment. */
export const projectFileSniffBytes = attachmentLimits.sniffBytes

const MIB = 1024 * 1024

/** Why a file of a project was not taken, in the client's words, without a final period. */
export const projectFileRefusalText: Readonly<Record<ProjectFileRefusal, string>> = Object.freeze({
  type_not_allowed:
    'Такой файл в проект добавить нельзя. Подойдут изображения, документы, таблицы, презентации, текст и исходный код',
  content_mismatch:
    'Файл повреждён или не соответствует своему расширению. Проверьте, что он открывается, и добавьте его снова',
  text_encoding:
    'Текстовый файл сохранён в неподходящей кодировке. Сохраните его в кодировке UTF-8 и добавьте снова',
  empty: 'Файл пустой или без имени. Проверьте его и добавьте снова',
  too_large: `Файл больше ${projectLimits.fileBytes / MIB} МБ. Уменьшите его или разделите на несколько`,
  path_invalid: `Путь к файлу слишком длинный: не больше ${projectFileLimits.pathParts} уровней папок и ${projectFileLimits.pathChars} знаков`,
  has_secret:
    'Похоже, в файле пароль или ключ — уберите его: агент получает этот файл в каждом чате проекта',
})

/** Whose room is full, in the client's words. */
export const projectSpaceFullText: Readonly<Record<'project' | 'workspace', string>> =
  Object.freeze({
    project: `Места в проекте не хватает: до ${projectLimits.projectBytes / MIB} МБ файлов на проект`,
    workspace: `Места не хватает: до ${projectLimits.workspaceBytes / (1024 * MIB)} ГБ файлов на все проекты`,
  })
