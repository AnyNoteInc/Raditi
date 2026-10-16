// The scenarios of the billing stand (docs/plan/37-billing-plan.md, «Проверочный стенд») and
// their runner. The scenarios themselves are in the four files below, by what they are about;
// scenario-kit.mjs holds what they are written with. The order of a run is the order of
// SCENARIOS in stand.mjs.
import { randomBytes } from 'node:crypto'

import {
  CheckFailed,
  atRest,
  lettersSayWhatIsStored,
  pagesShowWhatIsStored,
  scenarioContext,
} from './scenario-kit.mjs'
import { scenarios as operator } from './scenarios-operator.mjs'
import { scenarios as payment } from './scenarios-payment.mjs'
import { scenarios as renewal } from './scenarios-renewal.mjs'
import { scenarios as tariff } from './scenarios-tariff.mjs'

const scenarios = { ...payment, ...renewal, ...tariff, ...operator }

/** Runs the scenarios in order; the first check that does not hold ends the run. */
export async function runScenarios(stand, selected, { alive }) {
  const started = Date.now()
  // `letters`: the last row of the mirror of the outbox a scenario has read (`newMail`).
  const counter = { checks: 0, customers: 0, tag: randomBytes(3).toString('hex'), letters: 0 }
  for (const [index, scenario] of selected.entries()) {
    const run = scenarios[scenario.id]
    if (run === undefined) throw new Error(`Scenario ${scenario.id} is not written`)
    const t = scenarioContext({ ...stand, alive }, scenario, counter)
    const before = counter.checks
    const began = Date.now()
    // A failure reports what web and core said from here on.
    stand.scenarioBegins(scenario)
    let failed = true
    try {
      // Payments, cards, queued answers and withheld notifications of the scenario before.
      await t.shop.settle()
      await t.shop.control('reset', {})
      await run(t)
      await t.shop.settle()
      await atRest(t)
      await pagesShowWhatIsStored(t)
      await lettersSayWhatIsStored(t)
      failed = false
    } catch (error) {
      if (stand.signal.aborted) throw error
      const text = error instanceof CheckFailed ? error.message : (error?.stack ?? String(error))
      console.error(`FAIL ${scenario.id} («${scenario.row}»): ${text}`)
      throw new Error(`scenario ${scenario.id} failed`)
    } finally {
      // A pass a scenario paused runs again even when the scenario died before its own
      // `finally` could see to it: the next scenario, and whoever looks at a kept stand, has
      // all four. The failure of the scenario stays the reason of a failed run.
      await stand.schedulers.resumeAll().catch((error) => {
        if (!failed) throw error
      })
    }
    console.log(
      `PASS scenario ${index + 1}/${selected.length} ${scenario.id}: ${scenario.title} — ` +
        `${counter.checks - before} checks, ${((Date.now() - began) / 1000).toFixed(1)} s`,
    )
  }
  return { scenarios: selected.length, checks: counter.checks, ms: Date.now() - started }
}

/** The scenarios that are written: stand.test.mjs compares them with SCENARIOS. */
export const scenarioIds = Object.keys(scenarios)
