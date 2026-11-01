import { openAgent } from './agent-lib.mjs'
const [tag, origin] = process.argv.slice(2)
const a = await openAgent({ tag: `${tag}-new`, origin, startPath: '/administrator/index.php?option=com_content&view=articles' })
try {
  await a.observe('login')
  await a.fill(/- textbox "Username"/, 'spikeadmin'); await a.fill(/- textbox "Password"/, '<hidden>'); await a.click(/- button "Log in"/); await a.wait(1500, { until: 'load' })
  await a.observe('list')
  await a.click(/- link "New"|- button "New"/); await a.wait(1800, { until: 'load' })
  await a.observe('form')
  await a.fill(/- textbox "Title"/, 'Новая на копии')
  await a.fill(/"Rich Text Area/, 'Текст новой статьи')
  await a.observe('form2')
  await a.click(/- button "Save"/); await a.wait(1800, { until: 'load' })
  await a.observe('saved')
  console.log('msg:', a.lines(/saved|error|Warning/i).slice(0, 3).map((l) => l.trim().slice(0, 110)).join(' | '))
  await a.click(/- button "Close"/); await a.wait(1200, { until: 'load' })
  await a.observe('closed'); console.log('rows with it:', a.lines(/Новая на копии/).length)
} catch (e) { console.log('FAILED', e?.message?.slice(0, 200)); await a.observe('failed').catch(() => {}) } finally { await a.close() }
