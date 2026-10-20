import { afterAll, afterEach, expect } from 'vitest'

import { takeNetworkGuardViolations } from './network-guard.ts'

// Before every test file (vitest.config.ts). The guard has already refused the connection; the
// test that tried it fails as well, so a lost rule is not hidden behind an error it expected.
const refusedNothing = () =>
  expect(
    takeNetworkGuardViolations(),
    'A test tried to connect or to resolve a name outside this machine',
  ).toEqual([])
afterEach(refusedNothing)
// After the last test and after the file's own `afterAll` hooks, which run before this one. An
// attempt made in `beforeAll` or by work left running fails the test that happens to follow it.
afterAll(refusedNothing)
