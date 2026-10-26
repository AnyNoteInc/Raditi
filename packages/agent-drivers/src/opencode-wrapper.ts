import { envVarLimits } from '@repo/domain'

/** Everything the launch wrapper of the OpenCode driver needs to know about one turn. */
export interface OpencodeWrapperSettings {
  /** The CLI binary of the image architecture. */
  cli: string
  workdir: string
  /** JSON array of the CLI's arguments and the prompt, staged by command(). */
  args: string
  prompt: string
  /** The turn key and the MCP token: read and removed at once, then named pipes for the CLI. */
  secrets: readonly [llm: string, mcp: string]
  /** The whole environment of every CLI process. Nothing is inherited. */
  env: Readonly<Record<string, string>>
  /** Configuration directories the CLI must not write into. */
  readOnly: readonly string[]
  /**
   * What the CLI takes from the directory it runs in whatever its switches say: its plugin files
   * are imported into the CLI process. The wrapper keeps these names out of the working copy
   * while a CLI process is alive.
   */
  projectFiles: readonly string[]
  /**
   * Every directory above the working copy. The CLI looks for the same names on its way up to
   * the root of the Git repository; nothing puts them above it, and the wrapper starts no CLI
   * process if one is there.
   */
  above: readonly string[]
  /**
   * `.opencode` of the CLI's home: at start the CLI imports `{tool,tools}/*.{js,ts}` of it.
   * Nothing puts it there, and the wrapper starts no CLI process if it is there.
   */
  absent: readonly string[]
  /**
   * The CLI's configuration directories and the files the driver wrote into each. At start the
   * CLI imports `{plugin,plugins,tool,tools}/*.{js,ts}` of its configuration directory and the
   * files a `plugin` list of any document there names, and takes agents, commands and settings
   * from it. The wrapper starts no CLI process over anything else in these directories.
   */
  only: Readonly<Record<string, readonly string[]>>
  /** The session to carry over from the restored database, or null for a fresh one. */
  session: string | null
  /** XDG_CONFIG_HOME of export and import: no provider, no MCP server, no secret reference. */
  ioConfigHome: string
  exportPath: string
  /** What is removed between export and import: the restored database and every CLI cache. */
  wipe: readonly string[]
  /** The fields of the exported session row that survive, by name and JSON type. */
  sessionInfoKeys: Readonly<Record<string, 'string' | 'number' | 'object'>>
  /** The fields of the session row the platform sets anew. */
  sessionInfo: Readonly<Record<string, unknown>>
  mcpUrl: string
  /** The name of the MCP server in the CLI's configuration, as the CLI's log prints it. */
  mcpServer: string
  /**
   * The client's variables of the turn (docs/plan/53-chat-preview-release.md, Р13): files in the
   * tmpfs of `NAME\0value\0` pairs (cli-run.ts `envFiles`) that hold exactly these names, read
   * and removed at once like the credentials; null — the turn has none.
   */
  variables: { paths: readonly string[]; names: readonly string[] } | null
  /**
   * The script the commands of the CLI's shell tool read through BASH_ENV: the variables and the
   * egress proxy, in the tmpfs, written just before the CLI starts and removed when it exits.
   * Only the CLI of the turn gets BASH_ENV — never a value — and only its shell reads the file.
   */
  shellEnv: string
  /** The client egress proxy of the sandbox for those commands; null — they have no way out. */
  egressProxy: string | null
  /**
   * The open internet of the turn (owner's decision of 26.10.2026): the commands get HTTP_PROXY
   * as well, and the CLI itself — its fetch tool, the remote skills, the browser skill it starts
   * — the same proxy variables, never a value of the client.
   */
  internet: boolean
  /** The hosts those commands reach without the proxy: the platform's gateway and loopback. */
  noProxy: readonly string[]
  /** The session database the turn leaves: every value in it is masked when the CLI ends. */
  sessionDatabase: string
  /** The files of the session the snapshot takes: none may hold a value, byte for byte. */
  sessionFiles: readonly string[]
  /** What a value becomes there (ENV_VALUE_MASK). */
  mask: string
}

/**
 * The MCP server must accept the turn's token before a provider request is worth making. Runs in
 * a process of its own: the token, once it is a string, stays in the memory of whatever built
 * the request, and the wrapper lives for the whole turn. Token on stdin, address in argv.
 */
const MCP_CHECK = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let accepted = false;
try {
  const response = await fetch(process.argv[1], {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: 'Bearer ' + Buffer.concat(chunks).toString(),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raditi-turn', version: '1' },
      },
    }),
  });
  const text = (await response.text()).slice(0, 262_144);
  const rows = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split(/\\r?\\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5))
    : [text];
  accepted = response.status === 200 && rows.some((row) => {
    try {
      const answer = JSON.parse(row);
      return answer?.jsonrpc === '2.0' && answer.id === 0 && answer.result !== null && typeof answer.result === 'object';
    } catch {
      return false;
    }
  });
} catch {}
process.exit(accepted ? 0 : 1);
`

/**
 * The launch wrapper (`node run.mjs`, in the working copy, as the agent's uid). In this order:
 *
 * 1. Both credential files are read and removed. No command of the agent, and no CLI process
 *    that reads the restored database, finds them on disk.
 * 2. The site's own OpenCode files leave the working copy until the CLI has ended. The pinned
 *    CLI honours OPENCODE_DISABLE_PROJECT_CONFIG for the settings, agents and instructions of
 *    the directory it runs in, but its «v2» configuration service knows no switch: at start it
 *    walks from that directory up to the root of the Git repository and imports
 *    \`.opencode/{plugin,plugins}/*.{js,ts}\` and every file the \`plugin\` list of
 *    \`opencode.json\`, \`opencode.jsonc\` or \`.opencode/opencode.json\` names. Code of the
 *    repository would run inside the process that holds both credentials, before the model said
 *    a word. The three names are moved as they are, a symbolic link as a link. The CLI reads
 *    them once, when it starts: a file of these names that a command of the turn writes is not
 *    loaded by the running CLI and stays, as any other change — the next turn hides it again.
 *    No CLI process starts while one of the names is in the working copy or above it. The CLI
 *    imports code from its own home as well — plugins and tools of its configuration directory,
 *    tools of `~/.opencode`. The home is new in every sandbox and holds what the driver wrote
 *    and the two restored database files; no CLI process starts over anything else in those
 *    places either.
 * 3. A resumed turn carries its session over. The session database is everything the CLI
 *    knows — permissions, agent, model and directory of the session row outrank the driver's
 *    configuration — and a command of the previous turn could write into it. So the restored
 *    database is only read, by `opencode export`; the wrapper builds the import file anew from
 *    the listed fields of the session row and the messages, removes the database, and
 *    `opencode import` creates the one the turn runs on. Both run with a configuration that
 *    names no provider and no secret.
 * 4. The MCP server accepts the turn's token (a short process of its own).
 * 5. The CLI starts with an environment built from scratch — a crash report of its runtime is
 *    uploaded only when the environment asks for it — and takes each credential once, from a
 *    named pipe the configuration names as `{file:…}`. The value exists in no file, no
 *    environment and no argv. The wrapper holds the write end of each pipe from before the CLI
 *    starts, writes the value once a reader holds the pipe, takes the pipe off its path at once
 *    and closes it a few milliseconds later. Two kernels shaped this
 *    (docs/plan/49-credential-pipe.md). Under gVisor an open for writing that is refused
 *    because nobody reads yet still counts as a writer for a moment; the open of a reader that
 *    falls into that moment returns without a writer, and the CLI reads an empty credential.
 *    So no open is ever tried and refused. On macOS a reader that enters its next read just as
 *    the writer closes can miss the end of the value and wait for good. So the close comes
 *    when that read has long been waiting. Under gVisor a reader whose open stalls for longer
 *    than that hold, between counting itself and looking for the writer, can still miss the
 *    writer and wait in open() for good; the report names this window. What the CLI has not
 *    taken is forgotten as soon as it exits.
 * 6. The CLI's own MCP connection may still fail, and then the run goes on without the site's
 *    tools and exits 0. The only sign is one WARN line of `--print-logs`: on it the CLI is
 *    stopped and the turn fails.
 * 7. The client's variables (plan 53, Р13) are read and removed with the credentials. The CLI
 *    gets only BASH_ENV, the path of a script in the tmpfs; its shell tool runs commands in
 *    bash, which sources that script first, so only the agent's commands hold the values and
 *    HTTPS_PROXY of the egress proxy — the CLI, the MCP check, export and import hold neither;
 *    in the open internet of the turn the CLI alone gets the proxy variables, no value.
 *    The script goes with the CLI. When the CLI has ended, every value — as it is and as a JSON
 *    string holds it — is masked in each text column of the session database the snapshot
 *    takes; with secure_delete on and a VACUUM after it, no page keeps what a change freed, and
 *    the WAL is merged into the file. Then the files the snapshot takes are read byte for byte:
 *    a value still there — a trigger the agent's commands added, a process the CLI left that
 *    holds the database — fails the turn, as does any step of this that does not succeed.
 *
 * A failure of the wrapper is printed as the CLI's own `error` row, so the parser reports it.
 * The CLI stays in the process group of the sandbox runtime: a timeout or a cancellation of the
 * turn ends the wrapper, the CLI and its commands together.
 */
export function opencodeWrapper(settings: OpencodeWrapperSettings): string {
  return `import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const settings = ${JSON.stringify(settings)};
// A shorter value is neither masked nor refused (\`envVarLimits.maskMinBytes\` of @repo/domain).
const MASK_MIN_BYTES = ${envVarLimits.maskMinBytes};
const mcpCheck = ${JSON.stringify(MCP_CHECK)};
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
const IO_TIMEOUT_MS = 120_000;
// From the value to its end: by then the CLI's next read of the pipe waits in the kernel.
const PIPE_HOLD_MS = 5;
const MCP_DOWN = new RegExp('level=WARN[^\\\\n]*message="server unavailable"[^\\\\n]*\\\\bkey=' + settings.mcpServer + '\\\\b');

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const report = (message) =>
  process.stdout.write('\\n' + JSON.stringify({ type: 'error', error: { name: 'RaditiWrapperError', data: { message } } }) + '\\n');
const remove = (path) => rmSync(path, { recursive: true, force: true });
const secrets = [];
/** The client's variables, by name; their values never leave this process but in the script. */
let variables = [];
const forget = () => {
  for (const secret of secrets) {
    secret.value.fill(0);
    if (secret.pipe !== undefined) try { closeSync(secret.pipe); } catch {}
    secret.pipe = undefined;
    try { remove(secret.path); } catch {}
  }
  for (const path of settings.variables?.paths ?? []) try { remove(path); } catch {}
  try { remove(settings.shellEnv); } catch {}
};
/** Exactly the names the driver staged, each once with a value of text: anything else is refused. */
const readVariables = () => {
  if (settings.variables === null) return [];
  const pairs = [];
  // Every file is read and removed first: none stays behind a refusal.
  const texts = settings.variables.paths.map((path) => {
    const text = readFileSync(path, 'utf8');
    rmSync(path);
    return text;
  });
  for (const text of texts) {
    const parts = text.split('\\0');
    if (parts.length % 2 !== 1 || parts.pop() !== '') refuse('The client variables of the turn are not pairs');
    for (let index = 0; index < parts.length; index += 2) pairs.push([parts[index], parts[index + 1]]);
  }
  const names = pairs.map(([name]) => name);
  if (JSON.stringify(names) !== JSON.stringify([...settings.variables.names].sort()) ||
    pairs.some(([, value]) => value.length === 0))
    refuse('The client variables of the turn differ from what was staged');
  return pairs;
};
// $'…': only the backslash and the quote escaped, so the script takes twice a value at most.
const shellQuote = (value) => "$'" + value.replaceAll('\\\\', '\\\\\\\\').replaceAll("'", "\\\\'") + "'";
/** What bash sources before each command of the shell tool. */
const shellScript = () => {
  const lines = ['# The launch wrapper of the turn: client variables and the egress proxy (Р13).'];
  for (const [name, value] of variables) lines.push('export ' + name + '=' + shellQuote(value));
  if (settings.egressProxy !== null) {
    const proxy = shellQuote(settings.egressProxy);
    const direct = shellQuote(settings.noProxy.join(','));
    lines.push('export HTTPS_PROXY=' + proxy + ' https_proxy=' + proxy + ' NO_PROXY=' + direct + ' no_proxy=' + direct + ' NODE_USE_ENV_PROXY=1');
    if (settings.internet) lines.push('export HTTP_PROXY=' + proxy + ' http_proxy=' + proxy);
  }
  return lines.join('\\n') + '\\n';
};
/** What the CLI itself is given in the open internet: the proxy and what stays direct. */
const internetEnv = () => {
  if (!settings.internet || settings.egressProxy === null) return {};
  const direct = settings.noProxy.join(',');
  const proxy = settings.egressProxy;
  return { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: direct, no_proxy: direct };
};
const shellEnvNeeded = () => variables.length > 0 || settings.egressProxy !== null;
const inJsonString = (value) => JSON.stringify(value).slice(1, -1);
/**
 * Each value as it is, as a JSON string holds it once and twice and as the script quotes it,
 * longest first: the spellings \`envValueForms\` of @repo/domain masks in core — none of a value
 * shorter than MASK_MIN_BYTES.
 */
const valueForms = () => [...new Set(variables.filter(([, value]) => Buffer.byteLength(value, 'utf8') >= MASK_MIN_BYTES).flatMap(([, value]) => {
  const once = inJsonString(value);
  return [value, once, inJsonString(once), value.replaceAll('\\\\', '\\\\\\\\').replaceAll("'", "\\\\'")];
}))].sort((left, right) => right.length - left.length);
/** The bytes of each spelling: UTF-8, and UTF-16 in either order — a database may keep text so. */
const valueBytes = () => valueForms().flatMap((form) => {
  const little = Buffer.from(form, 'utf16le');
  return [Buffer.from(form, 'utf8'), little, Buffer.from(little).swap16()];
});
/** Whether a file holds one of the patterns, read in chunks with an overlap of the longest. */
const holdsAny = (path, patterns) => {
  if (!present(path)) return false;
  const keep = Math.max(...patterns.map((pattern) => pattern.length)) - 1;
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let tail = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return false;
      const joined = Buffer.concat([tail, chunk.subarray(0, read)]);
      if (patterns.some((pattern) => joined.includes(pattern))) return true;
      tail = joined.subarray(Math.max(0, joined.length - keep));
    }
  } finally {
    closeSync(fd);
  }
};
const quoteName = (name) => '"' + name.replaceAll('"', '""') + '"';
/**
 * Every value masked in every text column of the session database (and of its virtual tables).
 * SQLite keeps what a change frees in the pages until something overwrites it: with
 * secure_delete it overwrites that with zeros, and VACUUM writes a copy of the live rows only.
 * Then the WAL is merged into the database, and the files the snapshot takes are read byte for
 * byte: SQL saw only what a trigger let it change.
 */
const scrub = () => {
  const forms = valueForms();
  if (forms.length === 0) return;
  if (present(settings.sessionDatabase)) mask(forms);
  const patterns = valueBytes();
  if (settings.sessionFiles.some((path) => holdsAny(path, patterns)))
    throw new Error('A value of a client variable is left in the session');
};
const mask = (forms) => {
  const database = new DatabaseSync(settings.sessionDatabase);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA secure_delete = ON');
    const tables = database.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite~_%' ESCAPE '~'").all();
    for (const { name: table } of tables) {
      for (const { name: column } of database.prepare('SELECT name FROM pragma_table_info(?)').all(table)) {
        const field = quoteName(column);
        let text = field;
        let bytes = 'CAST(' + field + ' AS TEXT)';
        for (const _ of forms) {
          text = 'replace(' + text + ', ?, ?)';
          bytes = 'replace(' + bytes + ', ?, ?)';
        }
        const replaced = forms.flatMap((form) => [form, settings.mask]);
        const found = (cast) => forms.map(() => 'instr(' + field + ', ' + (cast ? 'CAST(? AS BLOB)' : '?') + ') > 0').join(' OR ');
        database.prepare('UPDATE ' + quoteName(table) + ' SET ' + field + ' = ' + text + " WHERE typeof(" + field + ") = 'text' AND (" + found(false) + ')').run(...replaced, ...forms);
        database.prepare('UPDATE ' + quoteName(table) + ' SET ' + field + ' = CAST(' + bytes + " AS BLOB) WHERE typeof(" + field + ") = 'blob' AND (" + found(true) + ')').run(...replaced, ...forms);
      }
    }
    database.exec('VACUUM');
    // A reader that still holds the WAL keeps frames of it from the database.
    if (database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0)
      throw new Error('The session database is still in use');
  } finally {
    database.close();
  }
};
const writable = (mode) => {
  for (const directory of settings.readOnly) try { chmodSync(directory, mode); } catch {}
};
const jsonType = (value) =>
  value !== null && typeof value === 'object' ? (Array.isArray(value) ? 'array' : 'object') : typeof value;
// Next to the working copy, on its filesystem: a rename, whatever the size and the kind.
const holding = join(dirname(settings.workdir), '.raditi-opencode-held');
const present = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const held = [];
let hidden = false;
const hide = () => {
  // Fails when the directory is there: what a run before this one hid is not this run's to move.
  mkdirSync(holding, { mode: 0o700 });
  hidden = true;
  for (const name of settings.projectFiles) {
    if (!present(join(settings.workdir, name))) continue;
    renameSync(join(settings.workdir, name), join(holding, name));
    held.push(name);
  }
};
/**
 * Puts the hidden files back and says what kept it from that, if anything. A file the turn wrote
 * where a hidden one belongs is not replaced, and neither of the two is thrown away.
 */
const reveal = () => {
  if (!hidden) return;
  let problem;
  try {
    for (const name of held.splice(0)) {
      if (present(join(settings.workdir, name))) problem = 'The turn wrote an OpenCode file over one the site already has';
      else renameSync(join(holding, name), join(settings.workdir, name));
    }
    if (problem === undefined) rmSync(holding, { recursive: true, force: true });
  } catch {
    // A command of the turn reached the holding place. Without this failure the capture would
    // take a working copy that lacks the site's own files, as if the turn had removed them.
    problem = "Could not put the site's OpenCode files back";
  }
  return problem;
};
/**
 * Before every CLI process: none of the names where the CLI's walk from the working copy finds
 * it, and in the CLI's own home nothing but what the driver wrote where the CLI loads from.
 */
const guard = () => {
  const found =
    [settings.workdir, ...settings.above].some((directory) =>
      settings.projectFiles.some((name) => present(join(directory, name)))) ||
    settings.absent.some(present) ||
    Object.entries(settings.only).some(([directory, names]) =>
      readdirSync(directory).some((name) => !names.includes(name)));
  if (found) refuse('An OpenCode file is where the CLI would load it');
};

try {
  for (const path of settings.secrets) {
    secrets.push({ path, value: readFileSync(path), done: false });
    rmSync(path);
  }
  variables = readVariables();
  const args = JSON.parse(readFileSync(settings.args, 'utf8'));
  hide();
  guard();
  // The CLI installs a plugin package into every configuration directory it can write to.
  writable(0o555);

  if (settings.session !== null) {
    const io = { ...settings.env, XDG_CONFIG_HOME: settings.ioConfigHome };
    const cli = (argv, stdout) => {
      guard();
      return spawnSync(settings.cli, argv, {
        cwd: settings.workdir,
        env: io,
        stdio: ['ignore', stdout, 'ignore'],
        timeout: IO_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }).status === 0;
    };
    let source;
    try {
      const output = openSync(settings.exportPath, 'w', 0o600);
      let exported;
      try { exported = cli(['export', settings.session], output); } finally { closeSync(output); }
      if (!exported) refuse('Could not export the previous session');
      if (statSync(settings.exportPath).size > MAX_EXPORT_BYTES) refuse('The export of the previous session is too large');
      try { source = JSON.parse(readFileSync(settings.exportPath, 'utf8')); }
      catch { refuse('The export of the previous session is not JSON'); }
    } finally {
      remove(settings.exportPath);
    }
    const info = source?.info;
    if (jsonType(info) !== 'object' || info.id !== settings.session || !Array.isArray(source.messages))
      refuse('The export of the previous session has an unexpected shape');
    const kept = Object.fromEntries(
      Object.entries(settings.sessionInfoKeys)
        .filter(([key, type]) => Object.hasOwn(info, key) && jsonType(info[key]) === type)
        .map(([key]) => [key, info[key]]),
    );
    for (const path of settings.wipe) remove(path);
    try {
      writeFileSync(
        settings.exportPath,
        JSON.stringify({ info: { ...kept, ...settings.sessionInfo }, messages: source.messages }),
        { mode: 0o600 },
      );
      if (!cli(['import', settings.exportPath], 'ignore')) refuse('Could not import the previous session');
    } finally {
      remove(settings.exportPath);
    }
  }

  // What ran so far had no credential. From here on they are used: on a directory checked again.
  guard();
  const checked = spawnSync(process.execPath, ['--input-type=module', '--eval', mcpCheck, settings.mcpUrl], {
    input: secrets[1].value,
    env: { PATH: settings.env.PATH },
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  if (checked.status !== 0) refuse('The MCP server did not accept the turn');

  for (const secret of secrets) {
    execFileSync('mkfifo', ['-m', '600', secret.path], { stdio: 'ignore' });
    // The write end, held until the value is handed over: the CLI never finds the pipe without
    // a writer. A pipe opens for writing without blocking only while a reader holds it, and for
    // this one open the reader is the wrapper itself.
    const own = openSync(secret.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      secret.pipe = openSync(secret.path, constants.O_WRONLY | constants.O_NONBLOCK);
    } finally { closeSync(own); }
  }
  // Only for the commands of the CLI's shell tool: bash sources it, the CLI itself never reads it.
  const env = { ...settings.env, ...internetEnv() };
  if (shellEnvNeeded()) {
    writeFileSync(settings.shellEnv, shellScript(), { mode: 0o400, flag: 'wx' });
    // bash whose stdin is a socket pair — what a runtime's pipe often is — takes itself for a
    // remote shell's, reads ~/.bashrc instead of BASH_ENV and stops there, unless it is nested.
    Object.assign(env, { BASH_ENV: settings.shellEnv, SHELL: '/bin/bash', SHLVL: '1' });
  }
  const input = openSync(settings.prompt, 'r');
  let child;
  try {
    // Not detached: the CLI and its commands share the process group the sandbox runtime kills.
    child = spawn(settings.cli, args, { cwd: settings.workdir, env, stdio: [input, 'inherit', 'pipe'] });
  } finally {
    closeSync(input);
  }
  let failure;
  const stop = (message) => {
    failure ??= message;
    child.kill('SIGKILL');
  };
  // A write into a pipe nobody reads fails with EPIPE and changes nothing (Node ignores
  // SIGPIPE): the value leaves this process only when the CLI holds the pipe.
  const feeder = setInterval(() => {
    try {
      for (const secret of secrets) {
        if (secret.done) continue;
        if (secret.served !== undefined) {
          // The end of the value, which the reader is waiting for by now.
          if (performance.now() - secret.served < PIPE_HOLD_MS) continue;
          closeSync(secret.pipe);
          secret.pipe = undefined;
          secret.done = true;
          continue;
        }
        let written;
        try {
          written = writeSync(secret.pipe, secret.value);
        } catch (error) {
          if (error.code === 'EPIPE') continue;
          throw error;
        }
        if (written !== secret.value.length) throw new Error('short write');
        secret.value.fill(0);
        // Off its path before the close: once the reader sees the end of the value, a second
        // open of the path finds nothing. With the path still there it would wait for a writer
        // for good.
        rmSync(secret.path, { force: true });
        secret.served = performance.now();
      }
      if (secrets.every((secret) => secret.done)) clearInterval(feeder);
    } catch {
      clearInterval(feeder);
      stop('Could not hand the turn credentials to the CLI');
    }
  }, 5);
  let log = '';
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    log = (log + chunk.toString('latin1')).slice(-8192);
    if (MCP_DOWN.test(log)) stop('The CLI could not connect to the MCP server');
  });
  let ended = false;
  // A CLI that could not start reports \`error\` and then \`close\`: the turn ends once.
  const end = (code, signal) => {
    if (ended) return;
    ended = true;
    clearInterval(feeder);
    forget();
    writable(0o700);
    const unrevealed = reveal();
    if (unrevealed !== undefined) failure ??= unrevealed;
    try { scrub(); } catch { failure ??= 'Could not mask the client variables in the session'; }
    if (failure !== undefined) {
      report(failure);
      process.exitCode = 1;
    } else process.exitCode = code ?? 128 + (os.constants.signals[signal] ?? 0);
  };
  child.on('error', () => {
    failure ??= 'Could not launch the CLI';
    end(1, null);
  });
  // The credentials go with the CLI. \`close\` waits for every holder of its stderr as well, and
  // a process the CLI left behind may keep it open for the rest of the turn.
  child.on('exit', () => {
    clearInterval(feeder);
    forget();
  });
  child.on('close', end);
} catch (error) {
  forget();
  writable(0o700);
  reveal();
  report(error instanceof Refusal ? error.message : 'Could not prepare the turn');
  process.exitCode = 1;
}
`
}
