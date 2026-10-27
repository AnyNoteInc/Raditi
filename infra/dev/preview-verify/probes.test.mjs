import assert from 'node:assert/strict'
import { test } from 'node:test'

import { passed, table, ustar, verdict } from './probes.mjs'

test('a blocked row passes only with a control that reached the target', () => {
  assert.equal(verdict({ expect: 'blocked', actual: 'closed', control: 'open' }), 'PASS')
  assert.equal(verdict({ expect: 'blocked', actual: 'dns', control: 'closed' }), 'VACUOUS')
  assert.equal(verdict({ expect: 'blocked', actual: 'open', control: 'open' }), 'FAIL')
  assert.equal(verdict({ expect: 'blocked', actual: 'closed' }), 'PASS')
  assert.equal(verdict({ expect: 'reachable', actual: 'open' }), 'PASS')
  assert.equal(verdict({ expect: 'reachable', actual: 'closed' }), 'FAIL')
  assert.equal(verdict({ expect: 'reachable' }), 'FAIL')
})

test('a probe that did not run, or a name that resolves, never passes', () => {
  assert.equal(verdict({ expect: 'blocked', actual: 'error', control: 'open' }), 'FAIL')
  assert.equal(verdict({ expect: 'reachable', actual: 'error' }), 'FAIL')
  assert.equal(verdict({ expect: 'blocked', actual: 'closed', control: 'error' }), 'FAIL')
  assert.equal(
    verdict({ expect: 'blocked', name: true, actual: 'closed', control: 'open' }),
    'FAIL',
  )
  assert.equal(verdict({ expect: 'blocked', name: true, actual: 'dns', control: 'open' }), 'PASS')
  // The control resolved the name: that the port is closed there does not matter.
  assert.equal(verdict({ expect: 'blocked', name: true, actual: 'dns', control: 'closed' }), 'PASS')
  assert.equal(verdict({ expect: 'blocked', name: true, actual: 'dns', control: 'dns' }), 'VACUOUS')
  assert.equal(passed([{ expect: 'blocked', actual: 'closed', control: 'closed' }]), false)
  assert.equal(passed([{ expect: 'reachable', actual: 'open' }]), true)
})

test('the table lines up its columns', () => {
  const lines = table([
    { from: 'host', to: 'a', expect: 'reachable', actual: 'open' },
    {
      from: 'PHP of A',
      to: 'host.docker.internal:5432',
      expect: 'blocked',
      actual: 'dns',
      control: 'open',
    },
  ]).split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[3], 'PHP of A  host.docker.internal:5432  blocked    dns   open     PASS')
})

test('the archive is ustar with a valid checksum and two end blocks', () => {
  const archive = ustar([{ path: 'index.php', content: '<?php echo 1;' }])
  assert.equal(archive.length, 512 * 4)
  assert.equal(archive.subarray(257, 263).toString('latin1'), 'ustar\0')
  let sum = 0
  for (let index = 0; index < 512; index++)
    sum += index >= 148 && index < 156 ? 0x20 : archive[index]
  assert.equal(parseInt(archive.subarray(148, 154).toString('latin1'), 8), sum)
  assert.ok(archive.subarray(1024).every((byte) => byte === 0))
})
