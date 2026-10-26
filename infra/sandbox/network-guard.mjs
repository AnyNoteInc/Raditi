/* global Buffer, console, process, setInterval */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { isIP } from 'node:net'

// Runs in a trusted network namespace, separate from the agent's PID/filesystem namespaces.
// The sandbox reaches the gateway's port and, when its policy lists client hosts or opens the
// internet, the port of the client egress proxy on the same address
// (docs/plan/53-chat-preview-release.md, Р13): nothing else, not even a name server.
const ip = process.env.GATEWAY_IPV4
const isPort = (value) => /^\d{1,5}$/.test(value ?? '') && +value >= 1 && +value <= 65535
const ports = [
  process.env.GATEWAY_PORT,
  ...(process.env.EGRESS_PORT ? [process.env.EGRESS_PORT] : []),
]
if (isIP(ip ?? '') !== 4 || !ports.every(isPort) || new Set(ports).size !== ports.length)
  throw new Error('Invalid network guard configuration')
const rule = (...args) =>
  execFileSync('/usr/sbin/iptables', ['--wait', '5', ...args], { stdio: 'pipe' })
try {
  for (const chain of ['INPUT', 'OUTPUT', 'FORWARD']) rule('-P', chain, 'DROP')
  rule('-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
  rule('-A', 'INPUT', '-i', 'lo', '-s', '127.0.0.1/32', '-d', '127.0.0.1/32', '-j', 'ACCEPT')
  // Only localhost itself: Docker's embedded DNS on 127.0.0.11 is deliberately excluded.
  rule('-A', 'OUTPUT', '-o', 'lo', '-d', '127.0.0.1/32', '-j', 'ACCEPT')
  for (const port of ports)
    rule('-A', 'OUTPUT', '-p', 'tcp', '-d', `${ip}/32`, '--dport', port, '-j', 'ACCEPT')
  writeFileSync('/run/raditi-guard/ready', Buffer.from('ready\n'), { mode: 0o600 })
  setInterval(() => {}, 60_000)
} catch {
  console.error('Network guard setup failed')
  process.exitCode = 1
}
