import { describe, expect, it } from 'vitest'

import { diffStat } from './diff-stat.ts'

const patch = (text: string) => new TextEncoder().encode(text)

describe('diffStat', () => {
  it('counts the lines of each file of a patch', () => {
    expect(
      diffStat(
        patch(
          'diff --git a/src/index.html b/src/index.html\nindex 1..2 100644\n--- a/src/index.html\n+++ b/src/index.html\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
        ),
      ),
    ).toEqual([{ path: 'src/index.html', additions: 2, deletions: 1 }])
  })

  it('reads a path git quoted, with its octal bytes (ревью, безопасность 2)', () => {
    expect(
      diffStat(
        patch(
          'diff --git "a/ci/jobs/\\321\\202\\320\\265\\321\\201\\321\\202.yml" "b/ci/jobs/\\321\\202\\320\\265\\321\\201\\321\\202.yml"\nnew file mode 100644\n',
        ),
      ),
    ).toEqual([{ path: 'ci/jobs/тест.yml', additions: 0, deletions: 0 }])
    expect(diffStat(patch('diff --git "a/a\\tb" "b/a\\tb"\n'))[0]!.path).toBe('a\tb')
  })

  it('marks a header it cannot read, never taking it for an ordinary file', () => {
    expect(diffStat(patch('diff --git "a/broken\\q" "b/broken\\q"\n'))[0]).toMatchObject({
      unreadable: true,
    })
    expect(diffStat(patch('diff --git nonsense\n'))[0]).toMatchObject({ unreadable: true })
  })
})
