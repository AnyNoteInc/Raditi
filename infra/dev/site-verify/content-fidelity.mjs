import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { WordpressPublishedContentGateway } from '../../../packages/site-adapters/src/wordpress-content.ts'

// What the site stores must be exactly what the receipt and the snapshot say, on real WordPress.
export async function contentFidelityFixture({ wp, url, siteId, signal }) {
  const applicationPassword = (
    await wp([
      'user',
      'application-password',
      'create',
      'synthetic_admin',
      'Raditi content fidelity fixture',
      '--porcelain',
    ])
  ).stdout.trim()
  assert(applicationPassword.length > 10)
  const gateway = new WordpressPublishedContentGateway({
    origin: url,
    siteId,
    username: 'synthetic_admin',
    applicationPassword,
    allowLoopbackHttp: true,
  })
  const create = async (fields) => {
    const id = (
      await wp([
        // Stored as an administrator would save it in wp-admin: without the kses save filters.
        '--user=synthetic_admin',
        'post',
        'create',
        '--post_type=page',
        '--post_status=publish',
        ...Object.entries(fields).map(([key, value]) => `--post_${key}=${value}`),
        '--porcelain',
      ])
    ).stdout.trim()
    assert.match(id, /^[1-9]\d*$/u)
    return `page:${id}`
  }
  const write = (state, mode, fields) =>
    gateway.conditionalWrite({
      callId: randomUUID(),
      siteId,
      epoch: 1,
      requestHash: createHash('sha256').update(JSON.stringify({ mode, fields })).digest('hex'),
      objectRef: state.objectRef,
      expectedStateHash: state.stateHash,
      deadlineAt: Date.now() + 15_000,
      ttlMs: 15_000,
      mode,
      fields,
    })
  const fields = (state) => ({ title: state.title, content: state.content, excerpt: state.excerpt })
  // WordPress' own view of the row, independent of the companion plugin.
  const stored = async (objectRef) => {
    const row = JSON.parse(
      (
        await wp([
          'post',
          'get',
          objectRef.split(':')[1],
          '--fields=post_title,post_content,post_excerpt',
          '--format=json',
        ])
      ).stdout,
    )
    return { title: row.post_title, content: row.post_content, excerpt: row.post_excerpt }
  }
  const publicHtml = async (objectRef) => {
    const response = await fetch(new URL(`/?page_id=${objectRef.split(':')[1]}`, url), {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    assert.equal(response.status, 200)
    return response.text()
  }
  // The plugin's own protocol, for requests the adapter would never send.
  const raw = async (route, body) => {
    const endpoint = new URL('/', url)
    endpoint.searchParams.set('rest_route', `/raditi/v1/${route}`)
    const response = await fetch(endpoint, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        authorization: `Basic ${Buffer.from(`synthetic_admin:${applicationPassword}`).toString('base64')}`,
        'x-raditi-site': siteId,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { gateway, create, write, fields, stored, publicHtml, raw }
}

export async function verifyPercentSigns({ create, gateway, write, fields, stored, publicHtml }) {
  const original = {
    title: 'Скидка 20% до конца месяца',
    content:
      '<div style="width:100%;flex-basis:33.33%"><a href="/%D0%BA%D0%BE%D0%BD%D1%82%D0%B0%D0%BA%D1%82%D1%8B/">100% хлопок</a></div>',
    excerpt: 'Предоплата 50%',
  }
  const objectRef = await create(original)
  const before = await gateway.read(objectRef)
  assert.deepEqual(fields(before), original)
  // wpdb::prepare() swaps every % for a 66 character placeholder; it must never be stored.
  const placeholder = /\{[a-f0-9]{64}\}/u
  const exact = async (expected, proof) => {
    const state = await gateway.read(objectRef)
    assert.deepEqual(fields(state), expected)
    assert.deepEqual(await stored(objectRef), expected)
    if (proof) assert.equal(proof.stateHash, state.stateHash)
    const html = await publicHtml(objectRef)
    assert.equal(placeholder.test(html), false)
    assert(html.includes(expected.content.match(/>([^<>]*%[^<>]*)</u)[1]))
    return state
  }

  // An edit without a percent sign still rewrites nothing else: the other fields keep theirs.
  const titleOnly = await write(before, 'edit', { title: 'Новая цена' })
  assert.equal(titleOnly.kind, 'committed')
  const retitled = await exact({ ...original, title: 'Новая цена' }, titleOnly)
  // Undo writes all three snapshot fields back, percent signs included.
  const undone = await write(retitled, 'restore', fields(before))
  assert.equal(undone.kind, 'committed')
  assert.deepEqual(await exact(original, undone), before)

  const changed = {
    title: 'Скидка 30% и рассрочка 0%',
    content:
      '<div style="width:50%"><a href="/%D1%86%D0%B5%D0%BD%D1%8B/?a=%20b">95% шерсть, 5% эластан</a></div>',
    excerpt: '%s %d %% %1$s 100%',
  }
  const edit = await write(before, 'edit', changed)
  assert.equal(edit.kind, 'committed')
  const edited = await exact(changed, edit)
  const restore = await write(edited, 'restore', fields(before))
  assert.equal(restore.kind, 'committed')
  assert.deepEqual(await exact(original, restore), before)
  console.log('PASS percent signs survive a WordPress edit and its undo byte for byte')
}

// The platform owns the write deadline. The site gets the time left as a duration (ttlMs);
// deadlineAt only names the operation, so a wrong clock on the customer server changes nothing.
export async function verifyClockIndependence({ wp, create, gateway, write, fields, raw, siteId }) {
  const objectRef = await create({ title: 'Clock', content: '<p>Clock</p>', excerpt: '' })
  const id = objectRef.split(':')[1]
  const before = await gateway.read(objectRef)
  const tomorrow = Date.now() + 86_400_000
  const operation = (deadlineAt) => ({
    callId: randomUUID(),
    siteId,
    epoch: 1,
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
    objectRef,
    deadlineAt,
  })
  const writing = (ref, state, title) => ({
    ...ref,
    expectedStateHash: state.stateHash,
    mode: 'edit',
    fields: { title },
  })
  const unknown = { version: 1, kind: 'unknown' }
  const fenced = { version: 1, kind: 'rejected', code: 'fenced' }

  // As on a server whose clock is far ahead: the deadline looks long gone, the time left decides.
  const ahead = writing(operation(1), before, 'Clock ahead')
  const proof = await raw(`content/${id}`, { ...ahead, ttlMs: 15_000 })
  assert.equal(proof.kind, 'committed')
  const written = await gateway.read(objectRef)
  assert.equal(written.title, 'Clock ahead')
  // A replay is the same operation with less time left, not another write.
  assert.deepEqual(await raw(`content/${id}`, { ...ahead, ttlMs: 9000 }), proof)

  // As on a server whose clock is far behind: no time is left, whatever the deadline looks like.
  const behind = writing(operation(tomorrow), written, 'Clock behind')
  assert.deepEqual(await raw(`content/${id}`, { ...behind, ttlMs: 0 }), fenced)
  const lost = operation(tomorrow)
  assert.deepEqual(await raw(`operations/${lost.callId}/reconcile`, { ...lost, ttlMs: -1 }), {
    version: 1,
    kind: 'not_committed',
    ...lost,
  })
  assert.deepEqual(
    await raw(`content/${id}`, { ...writing(lost, written, 'Late dispatch'), ttlMs: 15_000 }),
    fenced,
  )
  // While time is left, a missing receipt proves nothing and cancels nothing.
  const active = operation(1)
  assert.deepEqual(
    await raw(`operations/${active.callId}/reconcile`, { ...active, ttlMs: 5000 }),
    unknown,
  )
  assert.deepEqual(await raw(`operations/${active.callId}`), unknown)
  assert.deepEqual(await gateway.read(objectRef), written)

  // A request that carries only an absolute deadline is not accepted at all.
  const invalid = { version: 1, kind: 'rejected', code: 'invalid' }
  assert.deepEqual(
    await raw(`content/${id}`, writing(operation(tomorrow), written, 'No ttl')),
    invalid,
  )
  assert.deepEqual(await raw(`operations/${active.callId}/reconcile`, active), invalid)
  assert.deepEqual(await gateway.read(objectRef), written)

  const receipt = Object.fromEntries(Object.keys(lost).map((key) => [key, ahead[key]]))
  assert.deepEqual(
    await raw(`operations/${ahead.callId}/forget`, { ...receipt, ttlMs: 5000 }),
    fenced,
  )
  assert.deepEqual(await raw(`operations/${ahead.callId}`), proof)
  // An undo returns the page to the state that write expected.
  assert.equal((await write(written, 'restore', fields(before))).kind, 'committed')
  assert.deepEqual(await raw(`operations/${ahead.callId}/forget`, { ...receipt, ttlMs: 0 }), {
    version: 1,
    kind: 'forgotten',
    callId: ahead.callId,
  })
  assert.deepEqual(await raw(`operations/${ahead.callId}`), unknown)
  // The original request may still arrive, with time left as far as it can tell. No receipt and
  // no clock stops it: retiring the receipt moved the site fence past the epoch of that write.
  assert.deepEqual(await raw(`content/${id}`, { ...ahead, ttlMs: 15_000 }), fenced)
  assert.deepEqual(await gateway.read(objectRef), before)
  // A site without a stored fence (its only write was refused before the transaction) still
  // retires a receipt, or the host would retry it forever: the fence starts past that epoch.
  await wp(['option', 'delete', 'raditi_content_epoch'])
  const refusedOnly = operation(tomorrow)
  assert.deepEqual(
    await raw(`operations/${refusedOnly.callId}/forget`, { ...refusedOnly, ttlMs: 0 }),
    { version: 1, kind: 'forgotten', callId: refusedOnly.callId },
  )
  assert.equal((await wp(['option', 'get', 'raditi_content_epoch'])).stdout.trim(), '2')
  // Trusted fixture setup returns the fence to the epoch of the following scenarios.
  await wp(['option', 'update', 'raditi_content_epoch', '1'])
  console.log('PASS WordPress write deadlines do not depend on the clock of the site server')
}

// A column that cannot hold a character makes MySQL/MariaDB store other text and only warn.
export async function verifyStoredText({ wp, create, gateway, write, fields, stored }) {
  const sql = (query) =>
    wp(['eval', `global $wpdb; echo $wpdb->get_var(${JSON.stringify(query)});`])
  const php = (code) => wp(['eval', `global $wpdb; ${code}`])
  const collation = (
    await sql(
      "SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{$wpdb->posts}' AND COLUMN_NAME = 'post_excerpt'",
    )
  ).stdout.trim()
  assert.match(collation, /^utf8mb4_[a-z0-9_]+$/u)
  const objectRef = await create({
    title: 'Legacy charset',
    content: '<p>Text</p>',
    excerpt: 'Old',
  })
  const before = await gateway.read(objectRef)
  const column = (charset, collate) =>
    php(
      `$wpdb->query("ALTER TABLE {$wpdb->posts} MODIFY post_excerpt text CHARACTER SET ${charset} COLLATE ${collate} NOT NULL") or exit(1);`,
    )
  // A site whose tables were never converted from the three-byte utf8.
  await column('utf8mb3', 'utf8mb3_general_ci')
  try {
    const request = { excerpt: 'Доставка 🚚 за 2 часа' }
    const refused = await write(before, 'edit', request)
    assert.deepEqual(refused, { version: 1, kind: 'rejected', code: 'invalid', reason: 'storage' })
    assert.deepEqual(await gateway.read(objectRef), before)
    assert.deepEqual(await stored(objectRef), fields(before))
    // Text the column can hold is still written, and the receipt matches the stored row.
    const kept = await write(before, 'edit', { excerpt: 'Доставка за 2 часа' })
    assert.equal(kept.kind, 'committed')
    assert.equal((await gateway.read(objectRef)).stateHash, kept.stateHash)
  } finally {
    await column('utf8mb4', collation)
  }
  console.log('PASS WordPress refuses text its database would store differently')
}

// The platform snapshots a state as JSON with raw UTF-8 and limits those bytes (32 KiB).
const stateLimit = 32 * 1024
const stateSize = (state) => Buffer.byteLength(JSON.stringify(state))

export async function verifySizeLimit({ wp, create, gateway, write }) {
  const objectRef = await create({ title: 'О компании', content: '<p>Текст</p>', excerpt: '' })
  const before = await gateway.read(objectRef)
  // Characters that JSON encoders escape differently, then mostly two-byte Cyrillic.
  const text =
    '<p>Услуги/цены: "кавычки", \\ обратная черта,\tтабуляция,\nперенос, \u2028 разделитель, 🚚</p>' +
    'Русский текст страницы. '.repeat(600)
  const padding = stateLimit - stateSize({ ...before, content: text })
  assert(padding > 0 && padding < 8192)
  const content = text + 'a'.repeat(padding)
  const full = await write(before, 'restore', { content })
  assert.equal(full.kind, 'committed')
  const state = await gateway.read(objectRef)
  assert.equal(state.content, content)
  assert.equal(stateSize(state), stateLimit)

  const refused = await write(state, 'restore', { content: `${content}a` })
  assert.deepEqual(refused, { version: 1, kind: 'rejected', code: 'invalid', reason: 'size' })
  assert.deepEqual(await gateway.read(objectRef), state)

  // A page that outgrew the limit in wp-admin is reported as too large, not as a site outage.
  await wp([
    '--user=synthetic_admin',
    'post',
    'update',
    objectRef.split(':')[1],
    `--post_content=${'Я'.repeat(17_000)}`,
  ])
  await assert.rejects(gateway.read(objectRef), { code: 'CONTENT_TOO_LARGE' })
  console.log(
    'PASS the 32 KiB state limit counts UTF-8 bytes the same way on the site and the platform',
  )
}

// Agent text is always stored filtered, and the filter must never cost a page its markup.
export async function verifyMarkup({ create, gateway, write, fields, stored }) {
  const refusal = { version: 1, kind: 'rejected', code: 'invalid', reason: 'markup' }
  const widget =
    '<iframe src="https://example.test/map" width="100%" height="400"></iframe><script>window.raditiSyntheticWidget = 1</script>'
  const contacts = { title: 'Контакты', content: `<p>Часы работы: 9–18</p>${widget}`, excerpt: '' }
  const contactsRef = await create(contacts)
  const before = await gateway.read(contactsRef)
  assert.deepEqual(fields(before), contacts)
  // Neither keeping the widget (the filter would strip it) nor dropping it may replace the field.
  for (const content of [contacts.content.replace('9–18', '10–19'), '<p>Часы работы: 10–19</p>'])
    assert.deepEqual(await write(before, 'edit', { content }), refusal)
  assert.deepEqual(await gateway.read(contactsRef), before)
  assert.deepEqual(await stored(contactsRef), contacts)
  // Other fields of that page stay editable, and the widget survives the edit and its undo.
  const retitle = await write(before, 'edit', { title: 'Наши контакты', content: contacts.content })
  assert.equal(retitle.kind, 'committed')
  const retitled = await gateway.read(contactsRef)
  assert.deepEqual(fields(retitled), { ...contacts, title: 'Наши контакты' })
  assert.equal((await write(retitled, 'restore', fields(before))).kind, 'committed')
  assert.deepEqual(await gateway.read(contactsRef), before)

  const image =
    '<!-- wp:image {"id":12} --><figure class="wp-block-image"><img src="https://example.test/a.jpg" alt="" class="wp-image-12"/></figure><!-- /wp:image -->'
  const services = { title: 'Услуги', content: `${image}<p>Tom &amp; Jerry</p>`, excerpt: '' }
  const servicesRef = await create(services)
  const clean = await gateway.read(servicesRef)
  assert.deepEqual(fields(clean), services)
  // Markup or text the filter would drop from the agent's own value is refused, not stripped.
  for (const patch of [
    { content: services.content + widget },
    { content: `${services.content}<p onclick="synthetic()">x</p>` },
    { content: `${services.content}<p>5 < 6 > 4</p>` },
    // The filter deletes a tab inside a style value: "0<TAB>auto" would be stored as "0auto".
    { content: `${services.content}<p style="margin:0\tauto">x</p>` },
    // A link protocol outside the WordPress list would be cut down to "//chat?number=1".
    { content: `${services.content}<a href="viber://chat?number=1">Viber</a>` },
    { excerpt: '<a href="javascript:synthetic()">x</a>' },
    { title: 'Цена: 10%20' },
    { title: '<b>Услуги</b>' },
  ])
    assert.deepEqual(await write(clean, 'edit', patch), refusal)
  assert.deepEqual(await gateway.read(servicesRef), clean)
  // The filter may re-serialise (quotes, " />", entities, the separators of a style value); the
  // page keeps every tag, attribute and character.
  const classic = `<p style="font-family: 'Times New Roman', serif; text-align: center;">Tom & Jerry — новинка</p>`
  const edit = await write(clean, 'edit', { content: `${image}${classic}` })
  assert.equal(edit.kind, 'committed')
  const edited = await gateway.read(servicesRef)
  assert.equal(
    edited.content,
    `${image.replace('"/>', '" />')}<p style="font-family: &#039;Times New Roman&#039;, serif;text-align: center">Tom &amp; Jerry — новинка</p>`,
  )
  assert.equal(edit.stateHash, edited.stateHash)
  assert.equal((await write(edited, 'restore', fields(clean))).kind, 'committed')
  assert.deepEqual(await gateway.read(servicesRef), clean)

  // The same holds for the value an edit replaces. A style saved in wp-admin with a tab inside
  // a value cannot be written back through the filter: neither with it nor without it.
  const prices = { title: 'Цены', content: '<p style="margin:0\tauto">Цены</p>', excerpt: '' }
  const pricesRef = await create(prices)
  const tabbed = await gateway.read(pricesRef)
  assert.deepEqual(fields(tabbed), prices)
  for (const content of [prices.content.replace('>Цены<', '>Цены и услуги<'), '<p>Цены</p>'])
    assert.deepEqual(await write(tabbed, 'edit', { content }), refusal)
  assert.deepEqual(await gateway.read(pricesRef), tabbed)
  console.log('PASS WordPress edits refuse to lose markup instead of stripping it')
}

export async function verifyContentFidelity(context) {
  const fixture = await contentFidelityFixture(context)
  await verifyPercentSigns(fixture)
  await verifySizeLimit({ ...context, ...fixture })
  await verifyMarkup(fixture)
  await verifyClockIndependence({ ...context, ...fixture })
  await verifyStoredText({ ...context, ...fixture })
}
