import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

// Exercise real WordPress capabilities through application passwords, not mocked permissions.
export async function verifyContentPermissions({ wp, url, siteId, signal }) {
  const author = 'synthetic_content_author'
  const authorId = (
    await wp([
      'user',
      'create',
      author,
      'synthetic-content-author@example.test',
      '--role=author',
      `--user_pass=${randomBytes(24).toString('hex')}`,
      '--porcelain',
    ])
  ).stdout.trim()
  assert.match(authorId, /^[1-9]\d*$/u)
  const permissions = JSON.parse(
    (
      await wp([
        `--user=${authorId}`,
        'eval',
        'echo wp_json_encode(array("edit" => current_user_can("edit_posts"), "raw" => current_user_can("unfiltered_html")));',
      ])
    ).stdout,
  )
  assert.deepEqual(permissions, { edit: true, raw: false })
  const adminPermissions = (
    await wp([
      '--user=synthetic_admin',
      'eval',
      'echo current_user_can("unfiltered_html") ? "yes" : "no";',
    ])
  ).stdout.trim()
  assert.equal(adminPermissions, 'yes')
  const passwords = {}
  for (const username of [author, 'synthetic_admin']) {
    passwords[username] = (
      await wp([
        'user',
        'application-password',
        'create',
        username,
        'Raditi content permission fixture',
        '--porcelain',
      ])
    ).stdout.trim()
    assert(passwords[username].length > 10)
  }
  const postId = (
    await wp([
      'post',
      'create',
      '--post_type=post',
      '--post_status=publish',
      `--post_author=${authorId}`,
      '--post_title=Author original',
      '--post_content=<p>Author original</p>',
      '--post_excerpt=Original excerpt',
      '--porcelain',
    ])
  ).stdout.trim()
  assert.match(postId, /^[1-9]\d*$/u)
  const request = async (username, route, input) => {
    const endpoint = new URL('/', url)
    endpoint.searchParams.set('rest_route', `/raditi/v1/${route}`)
    const response = await fetch(endpoint, {
      method: input ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${passwords[username]}`).toString('base64')}`,
        'x-raditi-site': siteId,
        'content-type': 'application/json',
      },
      // The site is told how much of the deadline is left, never to compare clocks with it.
      body: input ? JSON.stringify({ ...input, ttlMs: input.deadlineAt - Date.now() }) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    // WordPress emits an empty REST body when an operation receipt does not exist.
    if (body === '') {
      assert.match(route, /^operations\//u)
      return null
    }
    const result = JSON.parse(body)
    return result?.kind === 'unknown' && route.startsWith('operations/') ? null : result
  }
  const read = () => request(author, `content/${postId}`)
  const write = (state, mode, fields, epoch = 1) => ({
    callId: randomUUID(),
    siteId,
    epoch,
    requestHash: createHash('sha256').update(JSON.stringify({ mode, fields })).digest('hex'),
    objectRef: `post:${postId}`,
    expectedStateHash: state.stateHash,
    deadlineAt: Date.now() + 15_000,
    mode,
    fields,
  })
  const original = await read()
  const initial = await request(
    'synthetic_admin',
    `content/${postId}`,
    write(original, 'edit', { content: original.content }),
  )
  assert.equal(initial.kind, 'committed')
  const unsafe = {
    title: '<b>Raw restored title</b>',
    content: '<script>globalThis.raditiSyntheticRestore = true</script><p>Restored</p>',
    excerpt: '<iframe src="about:blank"></iframe><p>Restored excerpt</p>',
  }
  const markup = { version: 1, kind: 'rejected', code: 'invalid', reason: 'markup' }
  for (const field of ['title', 'content', 'excerpt']) {
    const stripped = write(original, 'edit', { [field]: unsafe[field] })
    assert.deepEqual(await request(author, `content/${postId}`, stripped), markup)
    assert.deepEqual(await read(), original)
    assert.equal(await request(author, `operations/${stripped.callId}`), null)
  }
  console.log('PASS WordPress author edits with disallowed HTML are refused, not stripped')
  const edit = await request(
    author,
    `content/${postId}`,
    write(original, 'edit', {
      title: 'Author edited',
      content: '<p>Author edited</p>',
      excerpt: 'Edited excerpt',
    }),
  )
  assert.equal(edit.kind, 'committed')
  const edited = await read()
  assert.equal(edited.content, '<p>Author edited</p>')
  const editRef = Object.fromEntries(
    ['callId', 'siteId', 'epoch', 'requestHash', 'objectRef', 'deadlineAt'].map((key) => [
      key,
      key === 'deadlineAt' ? Date.now() + 15_000 : edit[key],
    ]),
  )
  assert.equal((await request(author, `operations/${edit.callId}/forget`, editRef)).code, 'invalid')
  assert.deepEqual(await request(author, `operations/${edit.callId}`), edit)
  console.log('PASS a WordPress author cannot retire durable operation evidence')

  // A post author's application password is not authority over site-wide fencing.
  const escalated = write(edited, 'edit', { content: edited.content }, 2147483647)
  const epochProof = await request(author, `content/${postId}`, escalated)
  const normalProof = await request(
    'synthetic_admin',
    `content/${postId}`,
    write(edited, 'edit', { content: edited.content }, 2),
  )
  if (epochProof.kind !== 'rejected' || normalProof.kind !== 'committed') {
    const error = new Error('WordPress author advanced the global fencing epoch')
    error.verificationOutput = JSON.stringify({ epochProof, normalProof, permissions })
    throw error
  }
  assert.equal(epochProof.code, 'invalid')
  assert.deepEqual(await read(), edited)
  assert.equal(await request(author, `operations/${escalated.callId}`), null)
  // Trusted fixture setup resets its own epoch before independent restore checks.
  await wp(['option', 'update', 'raditi_content_epoch', '1'])
  console.log('PASS only a WordPress administrator can advance the site fencing epoch')

  for (const field of ['title', 'content', 'excerpt']) {
    // Use the admitted epoch so a fencing rejection cannot hide a missing HTML guard.
    const forbidden = write(edited, 'restore', { [field]: unsafe[field] })
    const proof = await request(author, `content/${postId}`, forbidden)
    if (proof.kind !== 'rejected') {
      const error = new Error('WordPress author restore bypassed HTML permissions')
      error.verificationOutput = JSON.stringify({ field, proof, state: await read(), permissions })
      throw error
    }
    assert.equal(proof.code, 'invalid')
    assert.deepEqual(await read(), edited)
    assert.equal(await request(author, `operations/${forbidden.callId}`), null)
  }

  const safe = Object.fromEntries(
    ['title', 'content', 'excerpt'].map((field) => [field, original[field]]),
  )
  const restored = await request(author, `content/${postId}`, write(edited, 'restore', safe))
  assert.equal(restored.kind, 'committed')
  assert.deepEqual(await read(), original)
  const raw = await request(
    'synthetic_admin',
    `content/${postId}`,
    write(original, 'restore', unsafe),
  )
  assert.equal(raw.kind, 'committed')
  const adminRestored = await read()
  for (const field of ['title', 'content', 'excerpt'])
    assert.equal(adminRestored[field], unsafe[field])
  console.log(
    'PASS WordPress restore preserves safe text and requires permission for unfiltered HTML',
  )

  // The author may not replace a field they could not restore afterwards, but edits the others
  // and undoes that edit: the untouched unfiltered field is not rewritten.
  const mixed = await request(
    'synthetic_admin',
    `content/${postId}`,
    write(adminRestored, 'restore', { title: original.title, excerpt: original.excerpt }),
  )
  assert.equal(mixed.kind, 'committed')
  const widget = await read()
  assert.equal(widget.content, unsafe.content)
  const replaced = write(widget, 'edit', { content: '<p>Author text</p>' })
  assert.deepEqual(await request(author, `content/${postId}`, replaced), markup)
  assert.deepEqual(await read(), widget)
  const retitled = await request(
    author,
    `content/${postId}`,
    write(widget, 'edit', { title: 'Author retitled' }),
  )
  assert.equal(retitled.kind, 'committed')
  const afterTitle = await read()
  assert.equal(afterTitle.content, unsafe.content)
  const undone = await request(
    author,
    `content/${postId}`,
    write(
      afterTitle,
      'restore',
      Object.fromEntries(['title', 'content', 'excerpt'].map((field) => [field, widget[field]])),
    ),
  )
  assert.equal(undone.kind, 'committed')
  assert.deepEqual(await read(), widget)
  // Harmless markup that the filter only re-serialises still cannot be restored by the author.
  const image = await request(
    'synthetic_admin',
    `content/${postId}`,
    write(widget, 'restore', { content: '<p><img src="https://example.test/a.jpg" alt=""/></p>' }),
  )
  assert.equal(image.kind, 'committed')
  const withImage = await read()
  assert.deepEqual(
    await request(
      author,
      `content/${postId}`,
      write(withImage, 'edit', { content: '<p>Author text</p>' }),
    ),
    markup,
  )
  assert.deepEqual(await read(), withImage)
  console.log('PASS a WordPress author edits and undoes only what their permissions can restore')
  const detachedId = (
    await wp([
      'post',
      'create',
      '--post_status=publish',
      '--post_title=Detached receipt',
      '--porcelain',
    ])
  ).stdout.trim()
  const detachedBefore = await request('synthetic_admin', `content/${detachedId}`)
  const detachedWrite = {
    ...write(detachedBefore, 'edit', { title: 'Detached edited' }),
    objectRef: `post:${detachedId}`,
    deadlineAt: Date.now() + 3000,
  }
  const detachedProof = await request('synthetic_admin', `content/${detachedId}`, detachedWrite)
  assert.equal(detachedProof.kind, 'committed')
  await wp(['post', 'delete', detachedId, '--force'])
  const detachedRef = Object.fromEntries(
    ['callId', 'siteId', 'epoch', 'requestHash', 'objectRef', 'deadlineAt'].map((key) => [
      key,
      detachedWrite[key],
    ]),
  )
  assert.deepEqual(
    await request('synthetic_admin', `operations/${detachedWrite.callId}/reconcile`, detachedRef),
    detachedProof,
  )
  await setTimeout(Math.max(1, detachedWrite.deadlineAt - Date.now() + 100), undefined, { signal })
  assert.equal(
    (await request('synthetic_admin', `operations/${detachedWrite.callId}/forget`, detachedRef))
      .kind,
    'forgotten',
  )
  assert.equal(await request('synthetic_admin', `operations/${detachedWrite.callId}`), null)
  // Retiring a receipt moves the site fence past its epoch. Trusted fixture setup returns it
  // to the epoch of the following scenarios.
  await wp(['option', 'update', 'raditi_content_epoch', '1'])
  console.log(
    'PASS an administrator reconciles and retires evidence after its content object is deleted',
  )
}
