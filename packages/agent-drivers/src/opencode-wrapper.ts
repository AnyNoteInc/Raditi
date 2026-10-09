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
 *    environment and no argv; the pipe is removed as soon as it was read.
 * 6. The CLI's own MCP connection may still fail, and then the run goes on without the site's
 *    tools and exits 0. The only sign is one WARN line of `--print-logs`: on it the CLI is
 *    stopped and the turn fails.
 *
 * A failure of the wrapper is printed as the CLI's own `error` row, so the parser reports it.
 * The CLI stays in the process group of the sandbox runtime: a timeout or a cancellation of the
 * turn ends the wrapper, the CLI and its commands together.
 */
export function opencodeWrapper(settings: OpencodeWrapperSettings): string {
  return `import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

const settings = ${JSON.stringify(settings)};
const mcpCheck = ${JSON.stringify(MCP_CHECK)};
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
const IO_TIMEOUT_MS = 120_000;
const MCP_DOWN = new RegExp('level=WARN[^\\\\n]*message="server unavailable"[^\\\\n]*\\\\bkey=' + settings.mcpServer + '\\\\b');

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const report = (message) =>
  process.stdout.write('\\n' + JSON.stringify({ type: 'error', error: { name: 'RaditiWrapperError', data: { message } } }) + '\\n');
const remove = (path) => rmSync(path, { recursive: true, force: true });
const secrets = [];
const forget = () => {
  for (const secret of secrets) {
    secret.value.fill(0);
    try { remove(secret.path); } catch {}
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

  for (const secret of secrets) execFileSync('mkfifo', ['-m', '600', secret.path], { stdio: 'ignore' });
  const input = openSync(settings.prompt, 'r');
  let child;
  try {
    // Not detached: the CLI and its commands share the process group the sandbox runtime kills.
    child = spawn(settings.cli, args, { cwd: settings.workdir, env: settings.env, stdio: [input, 'inherit', 'pipe'] });
  } finally {
    closeSync(input);
  }
  let failure;
  const stop = (message) => {
    failure ??= message;
    child.kill('SIGKILL');
  };
  // A named pipe opens for writing without blocking only once a reader holds it: ENXIO until then.
  const feeder = setInterval(() => {
    try {
      for (const secret of secrets) {
        if (secret.done) continue;
        let pipe;
        try {
          pipe = openSync(secret.path, constants.O_WRONLY | constants.O_NONBLOCK);
        } catch (error) {
          if (error.code === 'ENXIO') continue;
          throw error;
        }
        let written;
        try { written = writeSync(pipe, secret.value); } finally { closeSync(pipe); }
        rmSync(secret.path, { force: true });
        if (written !== secret.value.length) throw new Error('short write');
        secret.value.fill(0);
        secret.done = true;
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
    if (failure !== undefined) {
      report(failure);
      process.exitCode = 1;
    } else process.exitCode = code ?? 128 + (os.constants.signals[signal] ?? 0);
  };
  child.on('error', () => {
    failure ??= 'Could not launch the CLI';
    end(1, null);
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
