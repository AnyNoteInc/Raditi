import { describe, expect, it } from 'vitest'

import { browserTaskInstructions, turnInstructions } from './turn-instructions.ts'

describe('turnInstructions', () => {
  it('names the preview the browser tools open, or why there is none', () => {
    expect(
      turnInstructions({ state: 'serving', origin: 'http://site-a-chat-b.localhost:8090' }),
    ).toContain('http://site-a-chat-b.localhost:8090')
    expect(turnInstructions({ state: 'unavailable', reason: 'no_database' })).toContain(
      'no database',
    )
    const starting = turnInstructions({
      state: 'starting',
      origin: 'http://site-a-chat-b.localhost:8090',
    })
    expect(starting).toContain('starting and will be served at http://site-a-chat-b.localhost:8090')
    expect(starting).toContain('try them again')
    const rules = turnInstructions({ state: 'absent' })
    expect(rules).toContain('«вы»')
    expect(rules).toContain('.gitea/')
    // What a release cannot carry is said to the client, not worked around (plan 53, Р3).
    expect(rules).toContain('## What a release can carry')
    expect(rules).toContain('no menus, widgets')
    expect(rules).not.toContain('{{database}}')
  })

  it('names the parts of the site the agent may write, and that its root is not one of them', () => {
    const files = {
      workingSet: {
        include: ['/site/templates/', '/site/modules/'],
        exclude: ['vendor/'],
        maxBytes: 64 * 1024 * 1024,
      },
      addOnlyPaths: ['site/files/agent/'],
      media: {
        extensions: {
          png: [{ offset: 0, hex: '89504e47' }],
          pdf: [{ offset: 0, hex: '25504446' }],
        },
        refusedNameParts: ['.php'],
        maxFileBytes: 8 * 1024 * 1024,
      },
    }
    const told = turnInstructions({ state: 'absent' }, { names: [], hosts: [] }, '', files)
    expect(told).toContain('## The files you may change')
    expect(told).toContain('only these parts of the site: site/templates/, site/modules/.')
    // A file of the root is refused with the whole pass: the agent says so instead (owner's
    // answer 3 of 19.10.2026).
    expect(told).toContain('robots.txt')
    expect(told).toContain('the platform cannot change this file of the site yet')
    expect(told).toContain('go only to site/files/agent/ — png, pdf, each at most 8 MiB')
    expect(told).toContain('give each new file a name of its own')
    expect(told.indexOf('## The files you may change')).toBeLessThan(told.indexOf('## Preview'))
    // Without media rules, no line of media; without a working set — the full tree — nothing.
    const { media: _media, ...noMedia } = files
    expect(turnInstructions({ state: 'absent' }, undefined, '', noMedia)).not.toContain(
      'go only to',
    )
    const full = turnInstructions({ state: 'absent' }, undefined, '', {})
    expect(full).not.toContain('## The files you may change')
    expect(full).toBe(turnInstructions({ state: 'absent' }))
  })

  it("says the calls of the site's stack only as its adapter words them (rule 8)", () => {
    const bare = turnInstructions({ state: 'absent' })
    // Nothing of a stack in the rules of the platform: no routes, no code of a CMS.
    for (const words of ['/wp/v2', '$wpdb', 'dbDelta']) expect(bare).not.toContain(words)
    const guide = '- On this site: a stack of a test — `wp_rest` POST /x.\n'
    const told = turnInstructions({ state: 'absent' }, { names: [], hosts: [] }, guide)
    expect(told).toContain(`table of the platform created or extended.\n${guide}- A new page`)
  })
})

describe('browserTaskInstructions (docs/plan/57-browser-tasks.md, Б20–Б24)', () => {
  const guide = '- Open the list of posts first.\n- Save a draft before you publish.'

  it('tells the agent the rules of a task in the browser and the stack’s guide', () => {
    const text = browserTaskInstructions(`${guide}\n\n`)
    // The client is answered as in every task.
    expect(text).toContain('addressing the client politely as «вы»')
    // No repository, the platform's tools only.
    expect(text).toContain('no repository and no working copy')
    expect(text).toContain('`web_*`')
    // Secrets are never asked for: the client signs in in the same browser.
    expect(text).toContain('Never ask for a password')
    expect(text).toContain('`web_help`')
    // Nothing on the site is undone, and saved objects are verified before going on.
    expect(text).toContain('the platform does not undo it')
    expect(text).toContain('`web_verify`')
    expect(text).toContain('never create the object again')
    // What the task saved is listed in the request, for a new session too (Б22).
    expect(text).toContain('The request lists what this task already saved on the site')
    // Irreversible and wide changes wait for the client's explicit request.
    expect(text).toContain("need the client's explicit")
    // Б34: a mass edit is refused, and the agent says so instead of looking for a way around.
    expect(text).toContain('at most 20 different objects')
    expect(text).toContain('do not look for another way')
    // A snapshot for the client: attached to the dialog, never seen by the agent (Б20).
    expect(text).toContain('`web_screenshot`')
    expect(text).toContain('you\n  never see it')
    expect(text.endsWith(`## The admin pages of this site\n${guide}\n`)).toBe(true)
  })

  it('names no stack, no repository rule and no preview', () => {
    const text = browserTaskInstructions('')
    expect(text).not.toMatch(/wordpress|bitrix|wp-admin/i)
    expect(text).not.toContain('The admin pages of this site')
    expect(text).not.toContain('Work only in the repository working copy')
    expect(text).not.toContain('## Preview')
  })

  it('leaves the rules of a task with a repository as they were', () => {
    const text = turnInstructions({ state: 'absent' })
    expect(text).toContain('Work only in the repository working copy')
    expect(text).not.toContain('web_help')
  })
})
