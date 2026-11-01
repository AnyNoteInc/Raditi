// read-screens.mjs <tag> <origin> <startPath> <login sel> <password sel> <submit sel> <login> <password> <signInPathRegex> <path>...
import { openAgent } from './agent-lib.mjs'
const [tag, origin, startPath, loginSel, passSel, submit, login, password, signInRe, ...paths] = process.argv.slice(2)
const re = new RegExp(signInRe)
const a = await openAgent({ tag, origin, startPath, signIn: { isSignInPage: (p) => re.test(p), login: loginSel, password: passSel, submit } })
try {
  await a.observe('start')
  console.log('signIn →', await a.session.signIn({ login, password }))
  await a.wait(1500)
  await a.observe('after-signin')
  let i = 0
  for (const p of paths) { i += 1; const name = `s${i}`; try { await a.open(p); await a.wait(1500); await a.observe(name) } catch (e) { console.log(`[${name}] ${p} FAILED ${e?.code ?? ''} ${e?.message?.slice(0, 120)}`) } }
} finally { await a.close() }
