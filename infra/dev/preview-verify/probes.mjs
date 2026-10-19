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
 * CONNECT from PHP through the egress proxy of the preview (Р13): `open` (200), `refused:<reason>`
 * (the proxy's own refusal and its reason), `closed` (no proxy) or `error`.
 */
export const PHP_CONNECT_PROBE = [
  '[, $proxy, $port, $target] = $argv;',
  '$socket = @fsockopen($proxy, (int) $port, $code, $message, 5);',
  'if (!$socket) { echo "closed"; exit(0); }',
  'stream_set_timeout($socket, 20);',
  'fwrite($socket, "CONNECT $target HTTP/1.1\\r\\nHost: $target\\r\\n\\r\\n");',
  '$head = ""; while (($line = fgets($socket)) !== false) { $head .= $line; if ($line === "\\r\\n") break; }',
  'if (preg_match("#^HTTP/1\\.1 200 #", $head)) { echo "open"; exit(0); }',
  'if (preg_match("#raditi-egress: (\\S+)#i", $head, $found)) { echo "refused:" . $found[1]; exit(0); }',
  'echo "error";',
].join(' ')

/**
 * An HTTP(S) request from PHP's curl through a proxy: the status it got, 0 without an answer.
 * `tunnel` — CONNECT first (HTTPS end to end), else a plain request handed to the proxy.
 */
export const PHP_PROXIED_GET_PROBE = [
  '[, $url, $proxy, $tunnel] = $argv;',
  '$curl = curl_init($url);',
  'curl_setopt_array($curl, [CURLOPT_PROXY => $proxy, CURLOPT_HTTPPROXYTUNNEL => $tunnel === "1",',
  'CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_NOPROXY => ""]);',
  '$body = curl_exec($curl);',
  'echo $body === false ? curl_getinfo($curl, CURLINFO_HTTP_CONNECTCODE) : curl_getinfo($curl, CURLINFO_HTTP_CODE);',
].join(' ')

/**
 * HTTPS from PHP's curl through the proxy to `$url`, its tunnel asked for `$connectTo`
 * (`CURLOPT_CONNECT_TO`, `host:port:listed-host:port`): the TLS of one name inside a tunnel of
 * another. `open` — the page came; `closed` — the proxy opened the tunnel (200) and closed it at
 * the ClientHello; otherwise `error`.
 */
export const PHP_FRONTED_GET_PROBE = [
  '[, $url, $proxy, $connectTo] = $argv;',
  '$curl = curl_init($url);',
  'curl_setopt_array($curl, [CURLOPT_PROXY => $proxy, CURLOPT_HTTPPROXYTUNNEL => true,',
  'CURLOPT_CONNECT_TO => [$connectTo], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,',
  'CURLOPT_NOPROXY => ""]);',
  '$body = curl_exec($curl);',
  '$tunnel = curl_getinfo($curl, CURLINFO_HTTP_CONNECTCODE);',
  'echo $body !== false ? "open" : ($tunnel === 200 ? "closed" : "error");',
].join(' ')

/**
 * What a proxy probe says for a row: `open` for a tunnel, `closed` only for the refusal the row
 * expects — a refusal for another reason (a name that did not resolve, a timeout) proves nothing
 * about the address rule and is an `error`.
 */
export function proxyOutcome(seen, reason) {
  if (seen === 'open') return 'open'
  return reason !== undefined && seen === `refused:${reason}` ? 'closed' : 'error'
}

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
