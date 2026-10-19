import { describe, expect, it } from 'vitest'

import { dbChangesOf } from './candidates.ts'

const side = (key: string) => ({ key, sha256: 'a'.repeat(64), sizeBytes: 120 })
const operation = (objectRef: string, fields: string[]) => ({
  kind: 'content_update',
  objectRef,
  fields,
  beforeHash: 'b'.repeat(64),
  afterHash: 'c'.repeat(64),
  before: side(`previews/s/p/${objectRef.replace(':', '-')}/before`),
  after: side(`previews/s/p/${objectRef.replace(':', '-')}/after`),
})

describe('the records a release changes', () => {
  it('are said by the platform from its plan, in Russian, without words of the agent', () => {
    expect(
      dbChangesOf([
        operation('page:42', ['title']),
        operation('post:7', ['title', 'content', 'excerpt']),
        operation('page:9', ['content', 'excerpt']),
        operation('wp_block:5', ['content']),
      ]),
    ).toEqual([
      {
        objectType: 'page',
        objectId: '42',
        fields: ['title'],
        text: 'Страница 42: изменится заголовок',
      },
      {
        objectType: 'post',
        objectId: '7',
        fields: ['title', 'content', 'excerpt'],
        text: 'Запись 7: изменятся заголовок, текст и описание',
      },
      {
        objectType: 'page',
        objectId: '9',
        fields: ['content', 'excerpt'],
        text: 'Страница 9: изменятся текст и описание',
      },
      // A type the operation does not name is a record, never the word of the notation.
      {
        objectType: 'wp_block',
        objectId: '5',
        fields: ['content'],
        text: 'Запись 5: изменится текст',
      },
    ])
    expect(dbChangesOf([])).toEqual([])
    for (const change of dbChangesOf([operation('page:1', ['title'])]))
      expect(change.text).not.toMatch(/[A-Za-z]/)
  })

  it('says the other kinds of a plan without an id of the preview or a word of the notation', () => {
    const kind = (name: string, objectRef: string, fields: string[]) => ({
      ...operation(objectRef, fields),
      kind: name,
    })
    const changes = dbChangesOf([
      kind('schema_migration', 'table:bookings', ['definition']),
      kind('option_update', 'option:blogname', ['value']),
      kind('post_create', 'page:1000000001', ['title', 'content', 'excerpt']),
    ])
    expect(changes.map((change) => change.text)).toEqual([
      'База данных сайта: новая таблица или новые поля',
      'Настройка сайта: изменится значение',
      'Новая страница',
    ])
    for (const change of changes) expect(change.text).not.toMatch(/[A-Za-z0-9]/)
    // A table's name is the agent's text: only its description, checked for a variable, has it.
    expect(changes[0]).toMatchObject({ objectType: 'table', objectId: '' })
  })

  it('refuses a plan it cannot read rather than guess', () => {
    expect(() => dbChangesOf([{ kind: 'option_update', objectRef: 'option:1' }])).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })
})
