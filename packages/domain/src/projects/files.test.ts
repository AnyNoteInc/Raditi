import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  freeProjectFilePath,
  projectFileKey,
  projectFileNameVariant,
  projectFileOf,
  projectFilePath,
  projectFilePathRefusal,
  projectFileTypeByName,
  projectFileTypes,
  projectRoomPercent,
  projectRoomRefusal,
  projectTextFileOf,
  projectTextOf,
  sniffProjectFile,
} from './files.ts'
import { projectLimits } from './limits.ts'

const MIB = 1024 * 1024
const bytes = (text: string) => new TextEncoder().encode(text)
const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isDomainError(error)
      ? `${error.code}:${String((error.details as { reason?: string } | undefined)?.reason ?? (error.details as { scope?: string } | undefined)?.scope ?? '')}`
      : 'other'
  }
  return null
}

describe('the types of the files of a project (ПР8)', () => {
  it('takes the types of attachments, text and source code, each extension once', () => {
    const extensions = projectFileTypes.flatMap((type) => type.extensions)
    expect(new Set(extensions).size).toBe(extensions.length)
    for (const name of [
      'Прайс.xlsx',
      'logo.png',
      'Бриф.pdf',
      'notes.md',
      'data.json',
      'page.html',
      'feed.xml',
      'ci.yml',
      'site.css',
      'App.tsx',
      'main.py',
      'list.csv',
    ])
      expect(projectFileTypeByName(name), name).not.toBeNull()
    expect(projectFileTypeByName('notes.md')?.kind).toBe('text')
    expect(projectFileTypeByName('App.tsx')?.kind).toBe('text')
    expect(projectFileTypeByName('logo.png')?.kind).toBe('image')
    expect(projectFileTypeByName('Бриф.pdf')?.kind).toBe('document')
  })

  it('refuses .env, .pem, .key and what is not listed', () => {
    for (const name of [
      '.env',
      '.env.local',
      'config.env',
      'server.pem',
      'id.key',
      'cert.p12',
      'run.exe',
      'README',
    ])
      expect(projectFileTypeByName(projectFilePath(name) ?? name), name).toBeNull()
  })

  it('tells the first bytes, as for an attachment', () => {
    expect(
      sniffProjectFile(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'image/png',
      ).ok,
    ).toBe(true)
    expect(sniffProjectFile(bytes('<html>'), 'image/png')).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
    expect(sniffProjectFile(bytes('# Заголовок'), 'text/markdown').ok).toBe(true)
    expect(sniffProjectFile(new Uint8Array([0x23, 0x00, 0x41]), 'text/x-source')).toEqual({
      ok: false,
      reason: 'text_encoding',
    })
    expect(sniffProjectFile(new Uint8Array(), 'text/markdown')).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(sniffProjectFile(bytes('x'), 'application/x-sh')).toEqual({
      ok: false,
      reason: 'type_not_allowed',
    })
  })

  it('reads a whole text only when every byte is UTF-8', () => {
    expect(projectTextOf(bytes('Цены — зима 2026'))).toBe('Цены — зима 2026')
    expect(projectTextOf(new Uint8Array([0xd0]))).toBeNull()
    expect(projectTextOf(new Uint8Array([0x41, 0x00]))).toBeNull()
  })
})

describe('the path of a file in a folder (ПР8)', () => {
  it('keeps the folders, cleans each part and drops empty ones', () => {
    expect(projectFilePath('Фото/витрина.jpg')).toBe('Фото/витрина.jpg')
    expect(projectFilePath('Фото\\Зима\\витрина.jpg')).toBe('Фото/Зима/витрина.jpg')
    expect(projectFilePath('/Фото//./витрина.jpg/')).toBe('Фото/витрина.jpg')
    // No hidden part: the dots at the ends go, as in the name of an attachment.
    expect(projectFilePath('.github/workflows/ci.yml')).toBe('github/workflows/ci.yml')
    expect(projectFilePath('a‮gpj.exe/b.txt')).toBe('agpj.exe/b.txt')
  })

  it('refuses `..`, more than eight parts and more than 255 characters', () => {
    expect(projectFilePath('../секрет.txt')).toBeNull()
    expect(projectFilePath('Фото/../../etc/passwd.txt')).toBeNull()
    expect(projectFilePath('Фото/ .. /a.txt')).toBeNull()
    expect(projectFilePath('1/2/3/4/5/6/7/a.txt')).toBe('1/2/3/4/5/6/7/a.txt')
    expect(projectFilePath('1/2/3/4/5/6/7/8/a.txt')).toBeNull()
    expect(projectFilePath(`${'p'.repeat(200)}/${'a'.repeat(60)}.txt`)).toBeNull()
    expect(projectFilePathRefusal('../a.txt')).toBe('path_invalid')
    expect(projectFilePathRefusal('//')).toBe('empty')
  })

  it('gives a free path: «(2)», «(3)», and never beside a folder of the same name', () => {
    expect(projectFileNameVariant('Фото/Брендбук.pdf', 2)).toBe('Фото/Брендбук (2).pdf')
    expect(freeProjectFilePath('Брендбук.pdf', [])).toBe('Брендбук.pdf')
    expect(freeProjectFilePath('Брендбук.pdf', ['Брендбук.pdf'])).toBe('Брендбук (2).pdf')
    expect(freeProjectFilePath('Брендбук.pdf', ['Брендбук.pdf', 'Брендбук (2).pdf'])).toBe(
      'Брендбук (3).pdf',
    )
    // A file «Фото» and a folder «Фото/» cannot lie side by side.
    expect(freeProjectFilePath('Фото/a.jpg', ['Фото'])).toBeNull()
  })
})

describe('the announcement of a file', () => {
  it('takes a listed type of the extension of the clean path', () => {
    expect(projectFileOf({ name: 'Фото/витрина.jpg', size: 10, type: 'image/jpeg' })).toMatchObject(
      { path: 'Фото/витрина.jpg', size: 10 },
    )
    expect(codeOf(() => projectFileOf({ name: 'a.jpg', size: 10, type: 'image/png' }))).toBe(
      'PROJECT_FILE_REFUSED:type_not_allowed',
    )
    expect(codeOf(() => projectFileOf({ name: '.env', size: 10, type: 'text/plain' }))).toBe(
      'PROJECT_FILE_REFUSED:type_not_allowed',
    )
    expect(codeOf(() => projectFileOf({ name: 'a.txt', size: 0, type: 'text/plain' }))).toBe(
      'PROJECT_FILE_REFUSED:empty',
    )
    expect(
      codeOf(() => projectFileOf({ name: 'a.txt', size: 20 * MIB + 1, type: 'text/plain' })),
    ).toBe('PROJECT_FILE_REFUSED:too_large')
    expect(codeOf(() => projectFileOf({ name: '../a.txt', size: 1, type: 'text/plain' }))).toBe(
      'PROJECT_FILE_REFUSED:path_invalid',
    )
  })

  it('keys an object under projects/<workspace>/<file>', () => {
    const ws = '0199a3f2-0000-7000-8000-000000000001'
    const file = '0199a3f2-0000-7000-8000-000000000002'
    expect(projectFileKey(ws, file)).toBe(`projects/${ws}/${file}`)
    expect(() => projectFileKey(ws.toUpperCase(), file)).toThrow()
  })
})

describe('the room of a project and a workspace (§4.7)', () => {
  it('refuses the 101st file, the 101st MiB of a project and the second GiB of a workspace', () => {
    const free = { workspaceBytes: 0, project: { files: 0, bytes: 0 } }
    expect(projectRoomRefusal(free, { files: 1, bytes: MIB })).toBeNull()
    expect(
      codeOf(() => {
        throw projectRoomRefusal(
          { ...free, project: { files: 100, bytes: 0 } },
          { files: 1, bytes: 1 },
        )
      }),
    ).toBe('PROJECT_FILES_TOO_MANY:')
    expect(
      codeOf(() => {
        throw projectRoomRefusal(
          { ...free, project: { files: 1, bytes: 100 * MIB - 10 } },
          { files: 1, bytes: 11 },
        )
      }),
    ).toBe('PROJECT_SPACE_FULL:project')
    expect(
      codeOf(() => {
        throw projectRoomRefusal(
          { workspaceBytes: projectLimits.workspaceBytes },
          { files: 1, bytes: 1 },
        )
      }),
    ).toBe('PROJECT_SPACE_FULL:workspace')
    expect(projectRoomRefusal({ workspaceBytes: 0 }, { files: 500, bytes: 10 })).toBeNull()
  })

  it('tells «Занято N %» in whole percent', () => {
    expect(projectRoomPercent(0)).toBe(0)
    expect(projectRoomPercent(1)).toBe(1)
    expect(projectRoomPercent(50 * MIB)).toBe(50)
    expect(projectRoomPercent(100 * MIB)).toBe(100)
  })
})

describe('«Добавить текстовое содержимое»', () => {
  it('keeps a text as a .md file under its title', () => {
    const file = projectTextFileOf({ title: 'Тон / голос бренда', text: '# Тон\nПишем на «вы».' })
    expect(file.path).toBe('Тон _ голос бренда.md')
    expect(new TextDecoder().decode(file.bytes)).toBe('# Тон\nПишем на «вы».')
    expect(projectTextFileOf({ title: 'notes.md', text: 'x' }).path).toBe('notes.md')
  })

  it('refuses an empty title or text, more than 100 000 characters and a secret', () => {
    expect(codeOf(() => projectTextFileOf({ title: ' ', text: 'x' }))).toBe(
      'PROJECT_FILE_REFUSED:empty',
    )
    expect(codeOf(() => projectTextFileOf({ title: 'a', text: '  ' }))).toBe(
      'PROJECT_FILE_REFUSED:empty',
    )
    expect(codeOf(() => projectTextFileOf({ title: 'a', text: 'я'.repeat(100_001) }))).toBe(
      'PROJECT_FILE_REFUSED:too_large',
    )
    expect(projectTextFileOf({ title: 'a', text: 'я'.repeat(100_000) }).bytes.byteLength).toBe(
      200_000,
    )
    expect(
      codeOf(() =>
        projectTextFileOf({ title: 'Доступы', text: 'Сайт: example.ru\nПароль: Qwerty123' }),
      ),
    ).toBe('PROJECT_TEXT_HAS_SECRET:')
  })

  it('takes ordinary source code without a false refusal', () => {
    const code = [
      'export function LoginForm({ onSubmit }: { onSubmit: (password: string) => void }) {',
      "  const [password, setPassword] = useState('')",
      '  return <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />',
      '}',
    ].join('\n')
    expect(projectTextFileOf({ title: 'login.tsx', text: code.repeat(200) }).path).toBe(
      'login.tsx.md',
    )
  })
})
