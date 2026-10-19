import { candidatePatchKey, type ObjectStorage } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { FILE_DIFF_LIMIT_BYTES, fileDiffOf, readFileDiff } from './candidate-diff.ts'

const header = 'diff --git a/wp-content/themes/cafe/header.php b/wp-content/themes/cafe/header.php'
const headerPart = [
  header,
  'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
  '--- a/wp-content/themes/cafe/header.php',
  '+++ b/wp-content/themes/cafe/header.php',
  '@@ -1 +1 @@',
  '-<p>+7 900 000-00-00</p>',
  '+<p>+7 900 111-11-11</p>',
  // A line of the hunk that looks like a header is not one: it starts with a space.
  ' diff --git a/other b/other',
  '',
].join('\n')
// `core.quotePath` on: the bytes of «файл» in octal, the name in quotes.
const quoted = [
  'diff --git "a/\\321\\204\\320\\260\\320\\271\\320\\273 \\"1\\".txt" "b/\\321\\204\\320\\260\\320\\271\\320\\273 \\"1\\".txt"',
  'new file mode 100644',
  '--- /dev/null',
  '+++ "b/\\321\\204\\320\\260\\320\\271\\320\\273 \\"1\\".txt"',
  '@@ -0,0 +1 @@',
  '+привет',
  '',
].join('\n')
const binary = [
  'diff --git a/wp-content/uploads/raditi/logo.png b/wp-content/uploads/raditi/logo.png',
  'new file mode 100644',
  'index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333',
  'GIT binary patch',
  'literal 12',
  'zcmZQzKn4N;',
  '',
  'literal 0',
  'HcmV?d00001',
  '',
].join('\n')
const patch = Buffer.from(`${headerPart}${quoted}${binary}`)

describe('the diff of one file of a candidate', () => {
  it('is the part of the patch from its header to the next one', () => {
    expect(fileDiffOf(patch, 'wp-content/themes/cafe/header.php')).toEqual({
      path: 'wp-content/themes/cafe/header.php',
      state: 'ready',
      diff: headerPart,
    })
  })

  it('finds a name git put in quotes, with octal bytes and an escaped quote', () => {
    expect(fileDiffOf(patch, 'файл "1".txt')).toEqual({
      path: 'файл "1".txt',
      state: 'ready',
      diff: quoted,
    })
    // The same name written without octal bytes (`core.quotePath` off).
    const raw = Buffer.from(
      'diff --git "a/файл \\"1\\".txt" "b/файл \\"1\\".txt"\nnew file mode 100644\n',
    )
    expect(fileDiffOf(raw, 'файл "1".txt').state).toBe('ready')
  })

  it('names a binary file instead of showing it, and says when a file is not in the patch', () => {
    expect(fileDiffOf(patch, 'wp-content/uploads/raditi/logo.png')).toEqual({
      path: 'wp-content/uploads/raditi/logo.png',
      state: 'binary',
      diff: null,
    })
    expect(fileDiffOf(patch, 'other').state).toBe('missing')
    expect(fileDiffOf(patch, 'wp-content/themes/cafe').state).toBe('missing')
  })

  it('shows no more than 256 KiB of one file', () => {
    const big = Buffer.from(`${header}\n@@ -1 +1 @@\n+${'x'.repeat(FILE_DIFF_LIMIT_BYTES)}\n`)
    expect(fileDiffOf(big, 'wp-content/themes/cafe/header.php')).toEqual({
      path: 'wp-content/themes/cafe/header.php',
      state: 'too_large',
      diff: null,
    })
  })

  it('reads the patch of the revision from the artifacts and says when it is not written yet', async () => {
    const taskId = '0199B2F4-6C1E-7A52-9F3D-2B8E4C7D1A60'
    const get = vi.fn(async (_bucket: string, key: string) =>
      key === candidatePatchKey(taskId, 2)
        ? (async function* () {
            yield patch.subarray(0, 100)
            yield patch.subarray(100)
          })()
        : null,
    )
    const storage = { get } as unknown as ObjectStorage

    await expect(
      readFileDiff(storage, { taskId, revision: 2, path: 'wp-content/themes/cafe/header.php' }),
    ).resolves.toMatchObject({ state: 'ready', diff: headerPart })
    expect(get).toHaveBeenCalledWith(
      'artifacts',
      'candidates/0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60/2/patch.diff',
    )
    await expect(
      readFileDiff(storage, { taskId, revision: 3, path: 'wp-content/themes/cafe/header.php' }),
    ).resolves.toEqual({ path: 'wp-content/themes/cafe/header.php', state: 'missing', diff: null })
  })
})
