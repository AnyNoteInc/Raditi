import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  BROWSER_TOOL_RESPONSE_MAX_BYTES,
  browserActionSchema,
  browserTaskCodeNames,
  browserTaskCodes,
  browserTaskError,
  browserToolArgumentSchemas,
  browserToolNames,
  browserToolResultSchema,
  isBrowserKeyCombo,
  type BrowserToolResult,
} from './tools.ts'

const attachment = '0196abcd-0000-7000-8000-0000000000a1'
const page = {
  pageId: 1,
  url: 'https://news.example.ru/wp-admin/post-new.php',
  title: 'Добавить запись',
}

/** Arguments every tool takes, the way an agent would send them. */
const valid: Record<(typeof browserToolNames)[number], Record<string, unknown>[]> = {
  web_open: [{ url: 'https://news.example.ru/wp-admin/post-new.php' }],
  web_observe: [{}, { maxChars: 8_000 }, { ref: 'f1e3' }],
  web_click: [
    { observation: 'o2', ref: 'e31' },
    { observation: 'o2', ref: 'e31', button: 'right', double: true },
  ],
  web_fill: [
    { observation: 'o2', ref: 'f1e2', text: 'Открытие филиала' },
    { observation: 'o2', ref: 'f1e2', text: '' },
  ],
  web_type: [{ text: 'Мы открылись.\nЖдём вас!' }],
  web_press: [
    { key: 'Enter' },
    { key: 'Control+A', observation: 'o2', ref: 'f1e4' },
    { key: 'Control++' },
  ],
  web_scroll: [
    { direction: 'down' },
    { direction: 'up', amount: 600, observation: 'o2', ref: 'e30' },
  ],
  web_tab: [{ action: 'list' }, { action: 'select', pageId: 2 }, { action: 'close', pageId: 2 }],
  web_upload: [
    { observation: 'o2', ref: 'e40', attachmentIds: [attachment] },
    // No reference: into the file chooser that waits.
    { attachmentIds: [attachment] },
  ],
  web_dialog: [{ accept: true }, { accept: false, text: 'нет' }],
  web_wait: [
    { ms: 2_000 },
    { ms: 15_000, until: 'networkidle' },
    { ms: 500, text: 'Запись опубликована' },
  ],
  web_help: [{ reason: 'login', message: 'Войдите в админку сайта, пожалуйста.' }],
  web_verify: [{}, { expect: 'publish' }],
}

const invalid: Record<(typeof browserToolNames)[number], Record<string, unknown>[]> = {
  web_open: [{}, { url: '' }, { url: `https://x.ru/${'a'.repeat(2048)}` }],
  web_observe: [{ maxChars: 999 }, { maxChars: 24_001 }, { ref: 'button' }, { selector: '#title' }],
  web_click: [
    { ref: 'e31' },
    { observation: 'o2' },
    { observation: 'o2', ref: 'e31', button: 'back' },
    { observation: 'o2', selector: 'button.publish' },
  ],
  web_fill: [
    { observation: 'o2', ref: 'e3', text: 'x'.repeat(10_001) },
    { observation: 'o2', ref: 'e3', text: 'a\u0000b' },
    { observation: 'o2', ref: 'e3' },
  ],
  web_type: [{ text: '' }, { text: '\u001b[2J' }],
  web_press: [
    { key: '' },
    { key: 'Control+Control+A' },
    { key: 'Hyper+A' },
    { key: 'ab' },
    { key: 'Enter', observation: 'o2' },
    { key: 'Enter', ref: 'e1' },
  ],
  web_scroll: [
    { direction: 'sideways' },
    { direction: 'down', amount: 0 },
    { direction: 'down', amount: 10_001 },
    { direction: 'down', ref: 'e1' },
  ],
  web_tab: [
    { action: 'list', pageId: 1 },
    { action: 'select' },
    { action: 'close' },
    { action: 'open' },
  ],
  web_upload: [
    { observation: 'o2', ref: 'e40', attachmentIds: [] },
    { observation: 'o2', ref: 'e40', attachmentIds: [attachment, attachment] },
    {
      observation: 'o2',
      ref: 'e40',
      attachmentIds: Array.from(
        { length: 11 },
        (_, index) => `0196abcd-0000-7000-8000-${String(index).padStart(12, '0')}`,
      ),
    },
    { observation: 'o2', ref: 'e40', attachmentIds: ['inbox/ws/a1'] },
    { observation: 'o2', ref: 'e40', path: '/etc/passwd' },
    { ref: 'e40', attachmentIds: [attachment] },
    { observation: 'o2', attachmentIds: [attachment] },
  ],
  web_dialog: [{}, { accept: 'yes' }],
  web_wait: [{}, { ms: 0 }, { ms: 15_001 }, { ms: 100, until: 'idle' }, { ms: 100, text: '' }],
  web_help: [
    { reason: 'payment', message: 'x' },
    { reason: 'login', message: '' },
    { reason: 'login', message: 'x'.repeat(501) },
  ],
  web_verify: [{ expect: 'trash' }, { objectId: '12' }],
}

describe('arguments of the web tools', () => {
  it('names thirteen tools of the family', () => {
    expect(browserToolNames).toHaveLength(13)
    expect(Object.keys(browserToolArgumentSchemas).sort()).toEqual([...browserToolNames].sort())
  })

  it('takes what an agent sends to each tool', () => {
    for (const tool of browserToolNames)
      for (const args of valid[tool]) {
        expect(
          browserToolArgumentSchemas[tool].parse(args),
          `${tool} ${JSON.stringify(args)}`,
        ).toEqual(args)
        expect(browserActionSchema.parse({ tool, ...args })).toEqual({ tool, ...args })
      }
  })

  it('refuses anything else, the same way as an action of the worker', () => {
    for (const tool of browserToolNames)
      for (const args of invalid[tool]) {
        const label = `${tool} ${JSON.stringify(args).slice(0, 80)}`
        expect(browserToolArgumentSchemas[tool].safeParse(args).success, label).toBe(false)
        expect(browserActionSchema.safeParse({ tool, ...args }).success, label).toBe(false)
      }
    expect(browserActionSchema.safeParse({ tool: 'web_evaluate', script: '1' }).success).toBe(false)
    expect(browserActionSchema.safeParse({ url: 'https://x.ru' }).success).toBe(false)
  })

  it('reads key combinations as Playwright presses them', () => {
    for (const key of [
      'Enter',
      'a',
      'Я',
      'Shift+Tab',
      'Control+Shift+K',
      'ControlOrMeta+a',
      'Control++',
      '+',
    ])
      expect(isBrowserKeyCombo(key), key).toBe(true)
    for (const key of ['', 'Shift+', 'Control+Control+a', 'Ctrl+a', 'a+b', 'Shift+Dead'])
      expect(isBrowserKeyCombo(key), key).toBe(false)
  })
})

describe('results of the web tools', () => {
  it('reads the answer to every tool', () => {
    const results: BrowserToolResult[] = [
      { tool: 'web_open', page },
      {
        tool: 'web_observe',
        observation: 'o3',
        page,
        tabs: [page],
        controller: 'agent',
        tree: '- button "Опубликовать" [ref=e31]',
        truncated: false,
      },
      {
        tool: 'web_click',
        page,
        checkpoint: { kind: 'post', objectId: '12', state: 'unverified' },
      },
      { tool: 'web_fill', page },
      { tool: 'web_type', page },
      { tool: 'web_press', page, dialog: { kind: 'beforeunload', message: '' } },
      { tool: 'web_scroll', page },
      { tool: 'web_tab', page: null, tabs: [] },
      { tool: 'web_upload', page, uploaded: 2, chooser: { multiple: true, accept: ['image/*'] } },
      { tool: 'web_dialog', page },
      { tool: 'web_wait', page, matched: false },
      { tool: 'web_help', requested: true, reason: 'captcha' },
      {
        tool: 'web_verify',
        matched: true,
        objects: [
          {
            kind: 'post',
            objectId: '12',
            state: 'verified',
            object: {
              kind: 'post',
              objectId: '12',
              title: 'Открытие филиала',
              status: 'publish',
              url: 'https://news.example.ru/otkrytie/',
              editUrl: 'https://news.example.ru/wp-admin/post.php?post=12&action=edit',
              images: 2,
              files: 1,
              featuredImage: true,
            },
          },
        ],
      },
    ]
    expect(new Set(results.map((result) => result.tool)).size).toBe(browserToolNames.length)
    for (const result of results) {
      expect(browserToolResultSchema.parse(result)).toEqual(result)
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
        BROWSER_TOOL_RESPONSE_MAX_BYTES,
      )
    }
  })

  it('keeps the largest observation within the response limit', () => {
    const result = {
      tool: 'web_observe' as const,
      observation: 'o999999999',
      page: {
        pageId: 1,
        url: `https://news.example.ru/${'ж'.repeat(2000)}`,
        title: 'ж'.repeat(300),
      },
      tabs: [],
      controller: 'agent' as const,
      tree: 'ж'.repeat(20_480),
      truncated: true,
    }
    expect(browserToolResultSchema.parse(result)).toEqual(result)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
      BROWSER_TOOL_RESPONSE_MAX_BYTES,
    )
  })

  it('refuses answers that carry more than the tool gives', () => {
    for (const bad of [
      { tool: 'web_open', page, screenshot: 'iVBORw0' },
      { tool: 'web_click', page: { ...page, url: undefined } },
      { tool: 'web_upload', page, uploaded: 0 },
      { tool: 'web_help', requested: false, reason: 'login' },
      { tool: 'web_observe', page },
      {
        tool: 'web_verify',
        matched: true,
        objects: [{ kind: 'post', objectId: '12', state: 'done' }],
      },
    ])
      expect(browserToolResultSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(
        false,
      )
  })
})

describe('browserTaskCodes', () => {
  it('has every code of §3.7 with a status and a short English text', () => {
    expect(browserTaskCodeNames).toEqual([
      'BROWSER_SESSION_UNAVAILABLE',
      'BROWSER_USER_IN_CONTROL',
      'BROWSER_STALE_OBSERVATION',
      'BROWSER_ACTION_DENIED',
      'BROWSER_ADDRESS_DENIED',
      'BROWSER_TIMEOUT',
      'BROWSER_ACTION_FAILED',
      'BROWSER_CHECKPOINT_UNVERIFIED',
      'BROWSER_ATTACHMENT_UNKNOWN',
      'BROWSER_UPLOAD_REFUSED',
    ])
    expect(Object.keys(browserTaskCodes)).toEqual([...browserTaskCodeNames])
    for (const code of browserTaskCodeNames) {
      const { status, message } = browserTaskCodes[code]
      expect(status >= 400 && status < 600, code).toBe(true)
      expect(message.length, code).toBeLessThanOrEqual(120)
      // Plain English for the agent: no address, no Cyrillic, no placeholder for a value.
      expect(message, code).toMatch(/^[\x20-\x7e]+$/)
      expect(message, code).not.toMatch(/https?:|\{|%s/)
    }
  })

  it('raises a domain error with the fixed text', () => {
    const error = browserTaskError('BROWSER_USER_IN_CONTROL')
    expect(isDomainError(error)).toBe(true)
    expect(error.code).toBe('BROWSER_USER_IN_CONTROL')
    expect(error.httpStatus).toBe(409)
    expect(error.message).toBe(browserTaskCodes.BROWSER_USER_IN_CONTROL.message)
  })
})
