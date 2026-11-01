// The agent's job in Joomla: sign in, open an article from the list, change its title and body, save and close, read it back.
import { openAgent } from './agent-lib.mjs'
const [tag, origin, title, bodyMark] = process.argv.slice(2)
const a = await openAgent({ tag: `${tag}-job`, origin, startPath: '/administrator/index.php?option=com_content&view=articles' })
try {
  await a.observe('login')
  await a.fill(/- textbox "Username"/, 'spikeadmin'); await a.fill(/- textbox "Password"/, '<hidden>')
  await a.click(/- button "Log in"/); await a.wait(1500, { until: 'load' })
  await a.observe('list')
  const tour = a.line(/- button "(Cancel|Close Tour|Skip)/); console.log('tour:', tour?.trim().slice(0, 100)); if (tour) { await a.click(/- button "(Cancel|Close Tour|Skip)/); await a.observe('list2') }
  await a.click(/- link "Welcome to your blog"/); await a.wait(1500, { until: 'load' })
  await a.observe('edit')
  await a.fill(/- textbox "Title"/, title)
  await a.observe('edit2')
  const bodyLine = a.lines(/textbox|paragraph/).filter((l) => /\[ref=f\d+e/.test(l)).slice(0, 12)
  console.log(bodyLine.map((l) => l.trim().slice(0, 100)).join('\n'))
  const editor = a.line(/"Rich Text Area/)
  console.log('editor line:', editor?.trim().slice(0, 140))
  if (editor) { await a.fill(/"Rich Text Area/, bodyMark) }
  await a.observe('edit3')
  await a.click(/- button "Toggle Dropdown"/); await a.wait(300)
  await a.observe('edit4')
  await a.click(/- button "Save & Close"/); await a.wait(1500, { until: 'load' })
  await a.observe('saved')
  console.log('message:', a.lines(/saved|Saved|error|Error/).slice(0, 4).map((l) => l.trim().slice(0, 120)).join(' | '))
} catch (e) { console.log('FAILED', e?.code ?? '', e?.message?.slice(0, 200)); await a.observe('failed').catch(() => {}) } finally { await a.close() }
