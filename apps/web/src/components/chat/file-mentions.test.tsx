import { describe, expect, it } from 'vitest'

import { foldersOf, mentionAt, mentionMatches, withMention } from './file-mentions'

const files = [
  'wp-content/themes/shop/style.css',
  'wp-content/themes/shop/functions.php',
  'wp-content/themes/shop/templates/header.php',
  'wp-content/plugins/forms/forms.php',
  'index.php',
]

describe('mentionAt', () => {
  it('finds the @ the caret stands in', () => {
    expect(mentionAt('поправь @sty', 12)).toEqual({ start: 8, query: 'sty' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('is not a mention in an address of mail, after a space or before the @', () => {
    expect(mentionAt('почта name@site.ru', 18)).toBeNull()
    expect(mentionAt('@style.css и ещё', 16)).toBeNull()
    expect(mentionAt('текст @abc', 3)).toBeNull()
  })
})

describe('mentionMatches', () => {
  it('without letters lists the top: folders, then files', () => {
    expect(mentionMatches(files, '').map((option) => option.path)).toEqual([
      'wp-content/',
      'index.php',
    ])
  })

  it('puts a name that begins with the letters first', () => {
    const paths = mentionMatches(files, 'head').map((option) => option.path)
    expect(paths[0]).toBe('wp-content/themes/shop/templates/header.php')
  })

  it('finds folders and files by any part of the path, case aside', () => {
    const found = mentionMatches(files, 'SHOP')
    expect(found[0]).toEqual({ path: 'wp-content/themes/shop/', folder: true })
    expect(found.some((option) => option.path.endsWith('style.css'))).toBe(true)
    expect(mentionMatches(files, 'нет-такого')).toEqual([])
  })

  it('keeps to the limit', () => {
    expect(mentionMatches(files, 'p', 3)).toHaveLength(3)
  })
})

describe('foldersOf', () => {
  it('names every folder once', () => {
    expect(foldersOf(['a/b/c.txt', 'a/d.txt'])).toEqual(['a/', 'a/b/'])
  })
})

describe('withMention', () => {
  it('puts the file in place of the letters and a space after it', () => {
    expect(withMention('поправь @sty', { start: 8, query: 'sty' }, 'a/style.css')).toEqual({
      text: 'поправь @a/style.css ',
      caret: 21,
    })
  })

  it('leaves a folder open to narrow and keeps the words after it', () => {
    expect(withMention('@wp и ещё', { start: 0, query: 'wp' }, 'wp-content/')).toEqual({
      text: '@wp-content/ и ещё',
      caret: 12,
    })
    expect(withMention('@st и ещё', { start: 0, query: 'st' }, 'style.css').text).toBe(
      '@style.css и ещё',
    )
  })
})
