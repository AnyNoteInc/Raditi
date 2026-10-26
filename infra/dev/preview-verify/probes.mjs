/* global Buffer */
// Pure parts of the preview network stand (verify-preview-network.mjs): the archive it writes
// into a preview, the probe scripts it runs inside containers and the table it prints.

/** A ustar archive of regular files: what PreviewRuntime.writeFiles takes. */
export function ustar(files) {
  const blocks = []
  for (const file of files) {
    const body = Buffer.from(file.content)
    const name = Buffer.from(file.path)
    if (name.length > 100) throw new Error('ustar fixture: path over 100 bytes')
    const header = Buffer.alloc(512)
    name.copy(header, 0)
    const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`
    header.write(octal(file.mode ?? 0o644, 8), 100, 'latin1')
    header.write(octal(0, 8), 108, 'latin1')
    header.write(octal(0, 8), 116, 'latin1')
    header.write(octal(body.length, 12), 124, 'latin1')
    header.write(octal(0, 12), 136, 'latin1')
    header.write('        ', 148, 'latin1')
    header.write(file.type ?? '0', 156, 'latin1')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** TCP from PHP: `open`, `closed` (refused, unroutable or timed out) or `dns` (name unknown). */
export const PHP_PROBE = [
  '$host = $argv[1]; $port = (int) $argv[2];',
  '$ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : gethostbyname($host);',
  'if (!filter_var($ip, FILTER_VALIDATE_IP)) { echo "dns"; exit(0); }',
  '$socket = @fsockopen($ip, $port, $code, $message, 3);',
  'echo $socket ? "open" : "closed";',
].join(' ')

/** The same from Node (the tools and the browser images). */
export const NODE_PROBE = [
  'const [host, port] = process.argv.slice(1);',
  "const socket = require('net').connect({ host, port: +port, timeout: 3000 });",
  'const done = (state) => { process.stdout.write(state); socket.destroy(); process.exit(0) };',
  "socket.on('connect', () => done('open'));",
  "socket.on('timeout', () => done('closed'));",
  "socket.on('error', (error) => done(error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' ? 'dns' : 'closed'));",
].join(' ')

/**
 * A probe passes when what was seen is what the row expects. A probe that could not run
 * (`error`) proves nothing either way, so it fails the row; a blocked name must not even resolve
 * (`dns`): a name that resolves inside is a way out by DNS, whatever the port. A blocked row whose
 * control could not reach the target either is `VACUOUS` — for a name, one the control could not
 * resolve — and fails the run as well.
 */
export function verdict(row) {
  if (row.actual === undefined || row.actual === 'error') return 'FAIL'
  if (row.expect === 'reachable') return row.actual === 'open' ? 'PASS' : 'FAIL'
  if (row.expect === 'blocked') {
    if (row.actual === 'open') return 'FAIL'
    if (row.name && row.actual !== 'dns') return 'FAIL'
    if (row.control === undefined || row.control === 'open') return 'PASS'
    if (row.control === 'error') return 'FAIL'
    return row.name && row.control === 'closed' ? 'PASS' : 'VACUOUS'
  }
  return 'NOTE'
}

/** The run fails on any row that did not pass. */
export const passed = (rows) => rows.every((row) => verdict(row) === 'PASS')

/** A plain text table: from, to, expected, seen, control, verdict. */
export function table(rows) {
  const head = ['from', 'to', 'expected', 'seen', 'control', 'result']
  const lines = rows.map((row) => [
    row.from,
    row.to,
    row.expect,
    row.actual ?? '-',
    row.control ?? '-',
    verdict(row),
  ])
  const widths = head.map((title, index) =>
    Math.max(title.length, ...lines.map((line) => String(line[index]).length)),
  )
  const format = (cells) =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join('  ')
      .trimEnd()
  return [
    format(head),
    format(widths.map((width) => '-'.repeat(width))),
    ...lines.map(format),
  ].join('\n')
}
