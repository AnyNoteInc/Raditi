import { describe, expect, it } from 'vitest'

import { turnInstructions } from './turn-instructions.ts'

describe('turnInstructions', () => {
  it('names the preview the browser tools open, or why there is none', () => {
    expect(
      turnInstructions({ state: 'serving', origin: 'http://site-a-chat-b.localhost:8090' }),
    ).toContain('http://site-a-chat-b.localhost:8090')
    expect(turnInstructions({ state: 'unavailable', reason: 'no_database' })).toContain(
      'no database',
    )
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
