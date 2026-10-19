import { describe, expect, it } from 'vitest'

import { hostingPathOf, hostingPathProblem, isHostingGuardError } from '@repo/domain'

import { ancestorsOf, hostingFullPath, temporaryName } from './paths.ts'

describe('paths of a hosting session', () => {
  it('joins the root the server reported with the segments', () => {
    expect(hostingFullPath('/home/u/public_html', ['wp-content', 'a.css'])).toBe(
      '/home/u/public_html/wp-content/a.css',
    )
    expect(hostingFullPath('/', ['index.php'])).toBe('/index.php')
    expect(hostingFullPath('/srv/site/', ['a'])).toBe('/srv/site/a')
  })

  it('refuses a path that could leave the root or hide a segment', () => {
    for (const path of [[], [''], ['..'], ['a', '.'], ['a/b'], ['a\\b'], ['a\nb'], ['a\0']])
      expect(() => hostingFullPath('/srv', path), JSON.stringify(path)).toThrow(
        expect.objectContaining({ name: 'HostingGuardError', guard: 'path' }),
      )
    expect(hostingPathProblem(Array.from({ length: 65 }, () => 'a'))).toBe('too deep')
    expect(hostingPathProblem(['a'.repeat(256)])).toBe('segment length')
    expect(hostingPathProblem(hostingPathOf('wp-content/themes/a.css'))).toBeNull()
  })

  it('names the folders a path passes through, outermost first', () => {
    expect(ancestorsOf(['a', 'b', 'c.txt'])).toEqual([['a'], ['a', 'b']])
    expect(ancestorsOf(['index.php'])).toEqual([])
  })

  it('makes temporary names that are dot files and nothing else', () => {
    expect(temporaryName('0123456789abcdef')).toBe('.raditi-0123456789abcdef.tmp')
    try {
      temporaryName('../x')
      expect.unreachable()
    } catch (error) {
      expect(isHostingGuardError(error)).toBe(true)
    }
  })
})
