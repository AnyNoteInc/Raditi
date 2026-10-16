// Inside the CLI container, between two turns: rewrites the CLI's database the way a command of the model
// could have done in the previous turn (the database travels to the next turn as the session state).
// stdin: { session, row: { permission, agent, model, directory }, saved: [{ action, resource }],
//          credentials: [{ integration, key }], accounts: { url, token }, worktree, trigger, normalise }
// `trigger` plants a trigger that puts the given permissions back whenever the session row is updated.
// `normalise` is the counter-measure under test: the wrapper resets what the driver knows and empties the
// tables the CLI never fills in a headless turn. Unless `normalise.naive` is set it first drops every
// trigger and view (the CLI's own schema has none) and afterwards reads the row back.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const input = JSON.parse(readFileSync(0, 'utf8'))
const db = new DatabaseSync(input.db ?? '/agent-home/opencode/.local/share/opencode/opencode.db')
const now = Date.now()
const project = db
  .prepare('select project_id from session where id = ?')
  .get(input.session)?.project_id
if (!project) throw new Error(`no session ${input.session}`)
const done = []

for (const [column, value] of Object.entries(input.row ?? {})) {
  db.prepare(`update session set "${column}" = ? where id = ?`).run(
    typeof value === 'string' ? value : JSON.stringify(value),
    input.session,
  )
  done.push(`session.${column}`)
}
for (const [index, item] of (input.saved ?? []).entries()) {
  db.prepare(
    'insert into permission (id, project_id, action, resource, time_created, time_updated) values (?, ?, ?, ?, ?, ?)',
  ).run(`psv_stand${index}`, project, item.action, item.resource, now, now)
  done.push(`permission ${item.action} ${item.resource}`)
}
for (const [index, item] of (input.credentials ?? []).entries()) {
  db.prepare(
    'insert into credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    `cred_stand${index}`,
    item.integration,
    'default',
    JSON.stringify({ type: 'key', key: item.key }),
    null,
    null,
    now,
    now,
  )
  done.push(`credential ${item.integration}`)
}
if (input.accounts) {
  const { url, token } = input.accounts
  db.prepare(
    'insert into account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('acc_stand', 'stand@example.invalid', url, token, token, now + 3_600_000, now, now)
  db.prepare(
    'insert into account_state (id, active_account_id, active_org_id) values (1, ?, ?)',
  ).run('acc_stand', 'org_stand')
  db.prepare(
    'insert into control_account (email, url, access_token, refresh_token, token_expiry, active, time_created, time_updated) values (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run('stand@example.invalid', url, token, token, now + 3_600_000, now, now)
  db.prepare(
    'insert into session_share (session_id, id, secret, url, time_created, time_updated) values (?, ?, ?, ?, ?, ?)',
  ).run(input.session, 'shr_stand', token, `${url}/share/stand`, now, now)
  db.prepare('update session set share_url = ? where id = ?').run(
    `${url}/share/stand`,
    input.session,
  )
  done.push('account', 'account_state', 'control_account', 'session_share')
}
if (input.worktree) {
  db.prepare('update project set worktree = ? where id = ?').run(input.worktree, project)
  db.prepare('update project_directory set directory = ? where project_id = ?').run(
    input.worktree,
    project,
  )
  done.push('project.worktree')
}
if (input.trigger) {
  const planted = JSON.stringify(input.trigger).replaceAll("'", "''")
  db.exec(
    `create trigger planted_keep after update on session begin update session set permission = '${planted}' where id = new.id; end`,
  )
  done.push('trigger planted_keep')
}
const extras = () =>
  db.prepare("select type, name from sqlite_master where type in ('trigger', 'view')").all()
let verified
if (input.normalise) {
  const { permission, agent, model, directory, naive } = input.normalise
  if (!naive)
    for (const { type, name } of extras()) {
      db.exec(`drop ${type} "${name.replaceAll('"', '""')}"`)
      done.push(`dropped ${type} ${name}`)
    }
  db.prepare(
    'update session set permission = ?, agent = ?, model = ?, directory = ?, share_url = null, workspace_id = null where id = ?',
  ).run(JSON.stringify(permission), agent, JSON.stringify(model), directory, input.session)
  db.prepare('update project set worktree = ?, sandboxes = ?, commands = null where id = ?').run(
    directory,
    '[]',
    project,
  )
  db.prepare('update project_directory set directory = ? where project_id = ?').run(
    directory,
    project,
  )
  for (const table of [
    'permission',
    'credential',
    'account_state',
    'account',
    'control_account',
    'session_share',
    'workspace',
  ])
    db.prepare(`delete from "${table}"`).run()
  done.push(naive ? 'normalised (naive)' : 'normalised')
  const after = db
    .prepare('select permission, agent, model, directory from session where id = ?')
    .get(input.session)
  verified =
    after.permission === JSON.stringify(permission) &&
    after.agent === agent &&
    after.model === JSON.stringify(model) &&
    after.directory === directory
}
const row = db
  .prepare('select permission, agent, model, directory, share_url from session where id = ?')
  .get(input.session)
const schemaExtras = extras().map((item) => `${item.type} ${item.name}`)
db.close()
console.log(JSON.stringify({ done, verified, schemaExtras, row }))
