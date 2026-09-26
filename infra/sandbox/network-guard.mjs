/* global Buffer, console, process, setInterval */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { isIP } from 'node:net'

// Runs in a trusted network namespace, separate from the agent's PID/filesystem namespaces.
const ip = process.env.GATEWAY_IPV4
const port = process.env.GATEWAY_PORT
if (isIP(ip ?? '') !== 4 || !/^\d{1,5}$/.test(port ?? '') || +port < 1 || +port > 65535)
  throw new Error('Invalid network guard configuration')
const rule = (...args) =>
  execFileSync('/usr/sbin/iptables', ['--wait', '5', ...args], { stdio: 'pipe' })
try {
  for (const chain of ['INPUT', 'OUTPUT', 'FORWARD']) rule('-P', chain, 'DROP')
  rule('-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
  rule('-A', 'INPUT', '-i', 'lo', '-s', '127.0.0.1/32', '-d', '127.0.0.1/32', '-j', 'ACCEPT')
  // Only localhost itself: Docker's embedded DNS on 127.0.0.11 is deliberately excluded.
  rule('-A', 'OUTPUT', '-o', 'lo', '-d', '127.0.0.1/32', '-j', 'ACCEPT')
  rule('-A', 'OUTPUT', '-p', 'tcp', '-d', `${ip}/32`, '--dport', port, '-j', 'ACCEPT')
  writeFileSync('/run/raditi-guard/ready', Buffer.from('ready\n'), { mode: 0o600 })
  setInterval(() => {}, 60_000)
} catch {
  console.error('Network guard setup failed')
  process.exitCode = 1
}
