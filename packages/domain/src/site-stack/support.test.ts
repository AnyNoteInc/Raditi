import { describe, expect, it } from 'vitest'

import type { AppEnv } from '../app-env.ts'
import { emptySiteStackFacts, type SiteStackFacts } from './facts.ts'
import {
  compareSiteVersions,
  generationOf,
  siteSupportOf,
  stackAxisOpen,
  type SiteSupportNow,
  type StackGeneration,
  type StackSupport,
  type StackSwitchRow,
} from './support.ts'

// The support is a value: no stack is compared here (rule 8). The shapes below are what the
// adapters declare (docs/plan/62-site-stacks.md, §2.3); a switch row carries the stack its caller
// picked it by, and the function never reads it.
const stack = 'joomla'

/** What WordPress declares: both ways open, no table, an unknown version narrows nothing. */
const wordpressLike: StackSupport = {
  files: 'on',
  browser: 'on',
  generations: [],
  refuseBelow: null,
  releaseNeedsChecks: false,
  unknownVersion: 'open',
}

/** A stack the platform does not connect at all. */
const closedStack: StackSupport = { ...wordpressLike, files: 'off', browser: 'off' }

const generation = (
  id: string,
  from: string,
  to: string,
  more: Partial<StackGeneration> = {},
): StackGeneration => ({
  id,
  from,
  to,
  php: ['8.1'],
  files: 'on',
  browser: true,
  ended: false,
  ...more,
})

/** A new stack: a table of generations, checks before a release, an unknown version closed. */
const newStack: StackSupport = {
  files: 'on',
  browser: 'on',
  generations: [
    generation('old', '3.9', '3.99', { ended: true }),
    generation('cur', '4.0', '5.99'),
    generation('shut', '2.0', '2.99', { files: 'off', browser: false }),
  ],
  refuseBelow: '1.6',
  releaseNeedsChecks: true,
  unknownVersion: 'closed',
}

/** The same stack with a branch that is open outside production only (Т4). */
const devBranchStack: StackSupport = {
  ...newStack,
  generations: [...newStack.generations, generation('next', '6.0', '6.99', { files: 'dev' })],
}

const facts = (more: Partial<SiteStackFacts> = {}): SiteStackFacts => ({
  ...emptySiteStackFacts,
  ...more,
})
const probe = (status: NonNullable<SiteStackFacts['probe']>['status']) => ({
  status,
  php: '8.1',
  reason: null,
  at: '2026-11-07T10:00:00.000Z',
})

const open: SiteSupportNow = {
  files: true,
  fileTurns: true,
  browser: true,
  limit: null,
  notice: null,
}
const stopped: SiteSupportNow = {
  files: false,
  fileTurns: false,
  browser: false,
  limit: 'stack_off',
  notice: null,
}

interface Case {
  readonly support: StackSupport
  readonly facts: SiteStackFacts
  readonly switches?: readonly StackSwitchRow[]
  readonly env?: AppEnv
  readonly is: SiteSupportNow
}

const cases: Record<string, Case> = {
  'a WordPress-like stack with an empty record is open': {
    support: wordpressLike,
    facts: facts(),
    is: open,
  },
  'a WordPress-like stack is open with any version': {
    support: wordpressLike,
    facts: facts({ cmsVersion: '1.0' }),
    is: open,
  },
  'a WordPress-like stack is open in production': {
    support: wordpressLike,
    facts: facts({ cmsVersion: '7.1.2' }),
    env: 'production',
    is: open,
  },
  'a closed stack gives neither way': {
    support: closedStack,
    facts: facts({ cmsVersion: '4.2' }),
    is: stopped,
  },
  'a closed stack with an empty record gives neither way': {
    support: closedStack,
    facts: facts(),
    is: stopped,
  },
  'a stack in dev is open in development': {
    support: { ...wordpressLike, files: 'dev', browser: 'dev' },
    facts: facts(),
    env: 'development',
    is: open,
  },
  'a stack in dev is open in test': {
    support: { ...wordpressLike, files: 'dev', browser: 'dev' },
    facts: facts(),
    env: 'test',
    is: open,
  },
  'a stack in dev is off in production': {
    support: { ...wordpressLike, files: 'dev', browser: 'dev' },
    facts: facts({ cmsVersion: '4.2' }),
    env: 'production',
    is: stopped,
  },
  // The early refusal of step 1 (Э9.1) reads the empty record: it gets the same answer.
  'a stack in dev is off in production on an empty record': {
    support: { ...newStack, files: 'dev', browser: 'dev' },
    facts: facts(),
    env: 'production',
    is: stopped,
  },
  // Т3: an unknown version closes the files, never the panel.
  'a new stack without a version keeps the panel': {
    support: newStack,
    facts: facts(),
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
  'a version below refuseBelow closes both ways': {
    support: newStack,
    facts: facts({ cmsVersion: '1.5.26' }),
    is: { ...stopped, limit: 'version_unsupported' },
  },
  'a version below refuseBelow closes both ways even with a known generation': {
    support: newStack,
    facts: facts({ cmsVersion: '1.5.26', generation: 'cur' }),
    is: { ...stopped, limit: 'version_unsupported' },
  },
  'a version_unsupported of the record closes both ways': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', limit: 'version_unsupported' }),
    is: { ...stopped, limit: 'version_unsupported' },
  },
  'an other_product of the record closes both ways': {
    support: newStack,
    facts: facts({ limit: 'other_product' }),
    is: { ...stopped, limit: 'other_product' },
  },
  'a generation with closed files and panel gives not_yet without the panel': {
    support: newStack,
    facts: facts({ cmsVersion: '2.3.0.2' }),
    is: { ...stopped, limit: 'not_yet' },
  },
  'the same generation by publicGeneration without a version closes the panel': {
    support: newStack,
    facts: facts({ publicGeneration: 'shut' }),
    is: { ...stopped, limit: 'version_unknown' },
  },
  'a public generation does not stand for the version of the files': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', publicGeneration: 'shut' }),
    is: open,
  },
  'a generation named by the record wins over the version': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', generation: 'shut' }),
    is: { ...stopped, limit: 'not_yet' },
  },
  'a generation id the table lacks falls back to the version': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', generation: 'gone' }),
    is: open,
  },
  // Numbers, not strings: '3.10.12' < '3.9' as text.
  '3.10.12 is in 3.9–3.99': {
    support: newStack,
    facts: facts({ cmsVersion: '3.10.12' }),
    is: { ...open, notice: 'vendor_ended' },
  },
  '3.8.13 is in no generation': {
    support: newStack,
    facts: facts({ cmsVersion: '3.8.13' }),
    is: { ...open, files: false, fileTurns: false, limit: 'not_yet' },
  },
  'a version above every generation gives not_yet with the panel': {
    support: newStack,
    facts: facts({ cmsVersion: '6.0.1' }),
    is: { ...open, files: false, fileTurns: false, limit: 'not_yet' },
  },
  // Т16: the layout closes the files, the panel stays.
  'an outside_root of the record keeps the panel': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', limit: 'outside_root' }),
    is: { ...open, files: false, fileTurns: false, limit: 'outside_root' },
  },
  'an encoding_unsupported of the record closes the files only': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', limit: 'encoding_unsupported' }),
    is: { ...open, files: false, fileTurns: false, limit: 'encoding_unsupported' },
  },
  // Т25: a dead trial boot or no database stops a file turn, not the files.
  'a failed probe stops file turns of a stack with checks': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', probe: probe('failed') }),
    is: { ...open, fileTurns: false },
  },
  'a probe without a database stops file turns of a stack with checks': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', probe: probe('no_database') }),
    is: { ...open, fileTurns: false },
  },
  'a pending probe does not stop file turns': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2', probe: probe('pending') }),
    is: open,
  },
  'a failed probe does not stop file turns of a stack without checks': {
    support: wordpressLike,
    facts: facts({ probe: probe('failed') }),
    is: open,
  },
  'a probe without a database does not stop file turns of a stack without checks': {
    support: wordpressLike,
    facts: facts({ probe: probe('no_database') }),
    is: open,
  },
  'a switch of the whole stack closes its axis': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2' }),
    switches: [{ stack, axis: 'files', generation: null }],
    is: { ...open, files: false, fileTurns: false, limit: 'stack_off' },
  },
  'a switch of the whole stack closes the panel': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2' }),
    switches: [{ stack, axis: 'browser', generation: null }],
    is: { ...open, browser: false },
  },
  'a switch of the generation closes its axis': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2' }),
    switches: [{ stack, axis: 'files', generation: 'cur' }],
    is: { ...open, files: false, fileTurns: false, limit: 'stack_off' },
  },
  'a switch of another generation narrows nothing': {
    support: newStack,
    facts: facts({ cmsVersion: '4.2' }),
    switches: [
      { stack, axis: 'files', generation: 'old' },
      { stack, axis: 'browser', generation: 'old' },
    ],
    is: open,
  },
  'a switch of a generation narrows nothing while the generation is unknown': {
    support: newStack,
    facts: facts(),
    switches: [{ stack, axis: 'browser', generation: 'cur' }],
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
  'an ended generation says so once': {
    support: newStack,
    facts: facts({ cmsVersion: '3.9.5', generation: 'old' }),
    is: { ...open, notice: 'vendor_ended' },
  },
  // The table of Э2.2 asks for the version before the generation: a named row alone is not one.
  'a generation named without a version still reads as an unknown version': {
    support: newStack,
    facts: facts({ generation: 'old' }),
    is: {
      ...open,
      files: false,
      fileTurns: false,
      limit: 'version_unknown',
      notice: 'vendor_ended',
    },
  },
  'an ended generation says nothing when both ways are closed': {
    support: newStack,
    facts: facts({ generation: 'old', limit: 'other_product' }),
    is: { ...stopped, limit: 'other_product' },
  },
  'an ended generation keeps its notice with the panel alone': {
    support: newStack,
    facts: facts({ generation: 'old', limit: 'outside_root' }),
    is: { ...open, files: false, fileTurns: false, limit: 'outside_root', notice: 'vendor_ended' },
  },
  // The two axes are separate values: a stack may declare files without the panel and back.
  'files in dev without the panel give the files alone in development': {
    support: { ...wordpressLike, files: 'dev', browser: 'off' },
    facts: facts(),
    is: { ...open, browser: false },
  },
  'files in dev without the panel give nothing in production': {
    support: { ...wordpressLike, files: 'dev', browser: 'off' },
    facts: facts(),
    env: 'production',
    is: stopped,
  },
  'the panel without files gives stack_off with the panel': {
    support: { ...wordpressLike, files: 'off', browser: 'on' },
    facts: facts(),
    is: { ...stopped, browser: true },
  },
  // Т4: a branch in dev is closed in production under a stack that is on.
  'a branch in dev gives not_yet in production': {
    support: devBranchStack,
    facts: facts({ cmsVersion: '6.1' }),
    env: 'production',
    is: { ...open, files: false, fileTurns: false, limit: 'not_yet' },
  },
  'a branch in dev is open in development': {
    support: devBranchStack,
    facts: facts({ cmsVersion: '6.1' }),
    is: open,
  },
  // §2.3, Т5: a closed files axis never opens the panel that the version or the record closes.
  'a files switch keeps the panel of a version below refuseBelow closed': {
    support: newStack,
    facts: facts({ cmsVersion: '1.5.26' }),
    switches: [{ stack, axis: 'files', generation: null }],
    is: stopped,
  },
  'a files switch keeps the panel of an other_product closed': {
    support: newStack,
    facts: facts({ limit: 'other_product' }),
    switches: [{ stack, axis: 'files', generation: null }],
    is: stopped,
  },
  'files in dev with the panel on keep a version below refuseBelow closed in production': {
    support: { ...newStack, files: 'dev', browser: 'on' },
    facts: facts({ cmsVersion: '1.5.26' }),
    env: 'production',
    is: stopped,
  },
  'a closed stack says stack_off over an other_product of the record': {
    support: closedStack,
    facts: facts({ limit: 'other_product' }),
    is: stopped,
  },
  // The order of the table: the first row that fires wins.
  'a version below refuseBelow wins over an outside_root of the record': {
    support: newStack,
    facts: facts({ cmsVersion: '1.5.26', limit: 'outside_root' }),
    is: { ...stopped, limit: 'version_unsupported' },
  },
  'a named generation with closed files gives not_yet without a version': {
    support: newStack,
    facts: facts({ generation: 'shut' }),
    is: { ...stopped, limit: 'not_yet' },
  },
  'refuseBelow itself is not below': {
    support: newStack,
    facts: facts({ cmsVersion: '1.6' }),
    is: { ...open, files: false, fileTurns: false, limit: 'not_yet' },
  },
  // The notice reads the branch of the files only: a guess from outside says nothing of the vendor.
  'an ended branch known from outside gives no notice': {
    support: newStack,
    facts: facts({ publicGeneration: 'old' }),
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
  // Т3, Т5: a branch switch of the panel reaches the branch the panel is judged by.
  'a panel switch of the branch known from outside closes the panel': {
    support: newStack,
    facts: facts({ publicGeneration: 'cur' }),
    switches: [{ stack, axis: 'browser', generation: 'cur' }],
    is: { ...stopped, limit: 'version_unknown' },
  },
  'a panel switch of another branch keeps the panel of a branch known from outside': {
    support: newStack,
    facts: facts({ publicGeneration: 'cur' }),
    switches: [{ stack, axis: 'browser', generation: 'old' }],
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
  'a files switch of the branch known from outside narrows nothing': {
    support: newStack,
    facts: facts({ publicGeneration: 'cur' }),
    switches: [{ stack, axis: 'files', generation: 'cur' }],
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
  // An empty table means «the version is not judged» (row 7 of the table does not fire).
  'an empty table with a closed unknown version judges only its absence': {
    support: { ...wordpressLike, unknownVersion: 'closed' },
    facts: facts({ cmsVersion: '0.1' }),
    is: open,
  },
  'an empty table with a closed unknown version refuses no version': {
    support: { ...wordpressLike, unknownVersion: 'closed' },
    facts: facts(),
    is: { ...open, files: false, fileTurns: false, limit: 'version_unknown' },
  },
}

describe('siteSupportOf', () => {
  it.each(Object.entries(cases))(
    '%s',
    (_, { support, facts, switches = [], env = 'development', is }) => {
      expect(siteSupportOf(support, facts, switches, env)).toEqual(is)
    },
  )
})

describe('stackAxisOpen', () => {
  it.each([
    ['on', 'production', true],
    ['on', 'development', true],
    ['dev', 'development', true],
    ['dev', 'test', true],
    ['dev', 'production', false],
    ['off', 'development', false],
    ['off', 'production', false],
  ] as const)('%s in %s is %s', (value, env, isOpen) => {
    expect(stackAxisOpen(value, env)).toBe(isOpen)
  })
})

describe('compareSiteVersions', () => {
  it.each([
    ['3.10.12', '3.9', 1],
    ['3.8.13', '3.9', -1],
    ['3.9', '3.9.0', 0],
    ['3.9', '3.9.0.0', 0],
    ['4.0.0.rc1', '4.0', 0],
    ['3.0.4.1b', '3.0.4.1', 0],
    ['2.8.9-pl', '2.8.9', 0],
    ['2.3.0.2.4', '2.3.0.2', 1],
    ['26.150.0', '26.99', 1],
    ['5.99', '5.100', -1],
  ] as const)('%s against %s is %d', (a, b, sign) => {
    expect(Math.sign(compareSiteVersions(a, b))).toBe(sign)
    expect(Math.sign(compareSiteVersions(b, a))).toBe(-sign || 0)
  })
})

describe('generationOf', () => {
  it('finds the row whose bounds hold the version, both ends included', () => {
    expect(generationOf(newStack, '3.9')?.id).toBe('old')
    expect(generationOf(newStack, '3.99')?.id).toBe('old')
    expect(generationOf(newStack, '3.10.12')?.id).toBe('old')
    expect(generationOf(newStack, '4.0.0')?.id).toBe('cur')
    expect(generationOf(newStack, '2.3.0.2.4')?.id).toBe('shut')
  })

  it('is null outside every row and on an empty table', () => {
    expect(generationOf(newStack, '3.8.13')).toBeNull()
    expect(generationOf(newStack, '6.0')).toBeNull()
    expect(generationOf(wordpressLike, '6.8.1')).toBeNull()
  })
})
