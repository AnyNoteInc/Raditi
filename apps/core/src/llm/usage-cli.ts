import { readFileSync, statSync } from 'node:fs'

import { createPrismaClient, dbConfigFromEnv, type PrismaClient } from '@repo/db'
import {
  absoluteWindow,
  appEnvSchema,
  isPlanPeak,
  planRatesSchema,
  planWindowCredits,
  tierPoolReservePct,
  workspaceTiers,
  type Env,
  type KnownAccountPlan,
  type PlanRates,
  type WorkspaceTier,
} from '@repo/domain'
import { decodeLimitWindows } from '@repo/turn-keys'
import { z } from 'zod'

// The operator's commands of the pool of the agent (docs/plan/70-usage-limits.md, §4.4). No Nest
// application, no queue, no `.env` discovery: APP_ENV and DATABASE_URL come from the command.
// They run from their TypeScript sources: no decorators, no parameter properties, no enum.
//
//   pnpm --filter core llm:usage [-- --json]
//     Read only. Each account of the pool: its plan, its windows of 5 hours and of the week in
//     plan credits, their share and reset by the Moscow clock, the forecast since the probe and
//     the age of the probe; the pool in total; the plan credits a credit of the customer took
//     over 7 days, at the peak and outside it; the power of the pool in credits of the customer;
//     the demand of the workspaces by tier; the coverage and what to add.
//
//   pnpm --filter core llm:plan-rates -- --file <rates.json> --provider <slug>
//     Adds the rows of llm_plan_rates the file names (only adds: a row of the same model and
//     moment with other values is refused, the same row again is nothing).

type Write = (text: string) => void

/** What the report is computed from: everything read before, nothing read during it. */
export interface UsageFacts {
  now: Date
  accounts: {
    label: string
    plan: string
    backend: string
    health: string
    enabled: boolean
    limitsSeenAt: Date | null
    limitWindows: unknown
    /** Σ plan credits of the calls after the probe, open calls by their reserve. */
    sinceProbe: number
  }[]
  /** Hours of the last 7 days: plan credits and credits of the customer of the calls. */
  hours: { hour: Date; planCredits: number; customerCredits: number }[]
  /** The plan rates in force for the peak; null — none is approved. */
  peakRates: PlanRates | null
  /** By tier: workspaces, Σ weekly limits, what they took in 7 days, p95 of a 5-hour window. */
  demand: {
    tier: WorkspaceTier
    workspaces: number
    weeklyLimits: number
    spent7d: number
    p95FiveHours: number
  }[]
}

export interface UsageReport {
  accounts: {
    label: string
    plan: string
    health: string
    probeAgeMinutes: number | null
    windows: {
      name: '5h' | 'week'
      used: number
      limit: number
      usedPct: number
      forecast: number
      resetsAt: string | null
    }[]
  }[]
  pool: Record<'5h' | 'week', { used: number; limit: number; freePct: number }>
  /** Plan credits per credit of the customer over 7 days; null — nothing measured. */
  ratio: { peak: number | null; offPeak: number | null; all: number | null }
  /** The weekly power of the pool in credits of the customer, by the measured ratio. */
  weeklyPowerCredits: number | null
  demand: UsageFacts['demand']
  coverage: number | null
  advice: string
}

const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places

/** The report of `llm:usage`, a pure function of what was read. */
export function usageReport(facts: UsageFacts): UsageReport {
  const pool = { '5h': { used: 0, limit: 0 }, week: { used: 0, limit: 0 } }
  const accounts = facts.accounts.map((account) => {
    const windows = (decodeLimitWindows(account.limitWindows) ?? [])
      .filter((window) => window.name !== 'month')
      .flatMap((window) => {
        const absolute = absoluteWindow(window, account.plan)
        if (absolute === null || window.name === 'month') return []
        const forecast = absolute.usedCredits + account.sinceProbe
        if (account.enabled && account.health === 'ok') {
          pool[window.name].used += Math.min(forecast, absolute.limitCredits)
          pool[window.name].limit += absolute.limitCredits
        }
        return [
          {
            name: window.name,
            used: round(absolute.usedCredits),
            limit: absolute.limitCredits,
            usedPct: round((absolute.usedCredits * 100) / absolute.limitCredits),
            forecast: round(forecast),
            resetsAt: window.resetsAt === null ? null : moscow.format(window.resetsAt),
          },
        ]
      })
    return {
      label: account.label,
      plan: account.plan,
      health: account.enabled ? account.health : 'disabled',
      probeAgeMinutes:
        account.limitsSeenAt === null
          ? null
          : Math.round((facts.now.getTime() - account.limitsSeenAt.getTime()) / 60_000),
      windows,
    }
  })
  const sums = { peak: [0, 0], offPeak: [0, 0] }
  for (const hour of facts.hours) {
    const peak = facts.peakRates !== null && isPlanPeak(hour.hour, facts.peakRates.peak)
    const sum = peak ? sums.peak : sums.offPeak
    sum[0]! += hour.planCredits
    sum[1]! += hour.customerCredits
  }
  const ratioOf = ([plan, customer]: number[]) =>
    customer! > 0 ? round(plan! / customer!, 2) : null
  const ratio = {
    peak: ratioOf(sums.peak),
    offPeak: ratioOf(sums.offPeak),
    all: ratioOf([sums.peak[0]! + sums.offPeak[0]!, sums.peak[1]! + sums.offPeak[1]!]),
  }
  const weeklyPowerCredits =
    ratio.all === null || ratio.all === 0 ? null : Math.floor(pool.week.limit / ratio.all)
  const weeklyDemand = facts.demand.reduce((total, tier) => total + tier.weeklyLimits, 0)
  const coverage =
    weeklyPowerCredits === null || weeklyDemand === 0
      ? null
      : round(weeklyPowerCredits / weeklyDemand, 2)
  return {
    accounts,
    pool: {
      '5h': { ...pool['5h'], freePct: freePct(pool['5h']) },
      week: { ...pool.week, freePct: freePct(pool.week) },
    },
    ratio,
    weeklyPowerCredits,
    demand: facts.demand,
    coverage,
    advice: adviceOf({ weeklyPowerCredits, weeklyDemand, ratio: ratio.all }),
  }
}

const freePct = ({ used, limit }: { used: number; limit: number }) =>
  limit === 0 ? 0 : round(((limit - used) * 100) / limit)

/** What to add for the promised weeks: the plan of the cheapest credit first (Max, Pro, Lite). */
function adviceOf(input: {
  weeklyPowerCredits: number | null
  weeklyDemand: number
  ratio: number | null
}): string {
  if (input.weeklyPowerCredits === null || input.ratio === null)
    return 'Мощность пула ещё не измерена: нет вызовов со ставками плана за 7 дней.'
  const deficit = input.weeklyDemand - input.weeklyPowerCredits
  if (deficit <= 0) return 'Мощности пула хватает на недельные лимиты всех пространств.'
  const plans: KnownAccountPlan[] = ['max', 'pro', 'lite']
  const max = planWindowCredits.max.week / input.ratio
  const accounts = Math.ceil(deficit / max)
  return `Не хватает ${Math.ceil(deficit)} кредитов в неделю: добавьте ${accounts} × Max (по ${Math.floor(max)} кредитов клиента в неделю; дешевле всего кредит у ${plans.join(', затем ')}).`
}

/** The report as an operator reads it in a terminal. */
export function usageReportText(report: UsageReport): string[] {
  const lines: string[] = ['Аккаунты пула:']
  for (const account of report.accounts) {
    const age =
      account.probeAgeMinutes === null
        ? 'проба не было'
        : `проба ${account.probeAgeMinutes} мин назад`
    lines.push(`  ${account.label} (${account.plan}, ${account.health}, ${age})`)
    for (const window of account.windows)
      lines.push(
        `    ${window.name === '5h' ? '5 часов' : 'неделя '}: ${window.used} из ${window.limit} (${window.usedPct} %), прогноз ${window.forecast}, сброс ${window.resetsAt ?? '—'}`,
      )
  }
  lines.push(
    `Пул: 5 часов — свободно ${report.pool['5h'].freePct} % из ${report.pool['5h'].limit}; неделя — ${report.pool.week.freePct} % из ${report.pool.week.limit}`,
    `Кредитов плана на кредит клиента за 7 дней: пик ${report.ratio.peak ?? '—'}, вне пика ${report.ratio.offPeak ?? '—'}, всего ${report.ratio.all ?? '—'}`,
    `Мощность пула в неделю: ${report.weeklyPowerCredits ?? '—'} кредитов клиента`,
    'Спрос по уровням:',
  )
  for (const tier of report.demand)
    lines.push(
      `  ${tier.tier}: пространств ${tier.workspaces}, недельные лимиты ${tier.weeklyLimits}, за 7 дней ${round(tier.spent7d)}, p95 окна 5 часов ${round(tier.p95FiveHours)} (запас пула ${tierPoolReservePct[tier.tier]} %)`,
    )
  lines.push(`Покрытие: ${report.coverage ?? '—'}`, report.advice)
  return lines
}

async function readFacts(prisma: PrismaClient, now: Date): Promise<UsageFacts> {
  const accounts = await prisma.$queryRaw<UsageFacts['accounts']>`
    SELECT a.label, a.plan, p.slug AS backend, a.health::text AS health,
      (a.enabled AND a.status = 'active') AS enabled, a.limits_seen_at AS "limitsSeenAt",
      a.limit_windows AS "limitWindows",
      (COALESCE((SELECT SUM(u.plan_credits) FROM token_usage u
         WHERE u.subscription_account_id = a.id AND a.limits_seen_at IS NOT NULL
           AND u.occurred_at >= a.limits_seen_at), 0)
       + COALESCE((SELECT SUM(c.reserved_plan_credits) FROM llm_calls c
         WHERE c.subscription_account_id = a.id AND c.state = 'open'), 0))::float8 AS "sinceProbe"
    FROM subscription_accounts a JOIN llm_providers p ON p.id = a.provider_id
    WHERE a.status <> 'retired' ORDER BY a.label`
  const hours = await prisma.$queryRaw<UsageFacts['hours']>`
    SELECT date_trunc('hour', u.occurred_at) AS hour,
      SUM(u.plan_credits)::float8 AS "planCredits",
      SUM(u.cost_rub / r.rub_per_credit)::float8 AS "customerCredits"
    FROM token_usage u
    CROSS JOIN LATERAL (SELECT c.rub_per_credit FROM credit_rates c
      WHERE c.effective_from <= u.occurred_at ORDER BY c.effective_from DESC LIMIT 1) r
    WHERE u.occurred_at >= ${new Date(now.getTime() - 7 * 86_400_000)}
      AND u.plan_credits IS NOT NULL AND u.billable
    GROUP BY 1 ORDER BY 1`
  const rate = await prisma.llmPlanRate.findFirst({
    where: { effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
  })
  const peakRates =
    rate === null
      ? null
      : planRatesSchema.parse({
          inputUncachedPer10k: rate.inputUncachedPer10k.toFixed(),
          cacheReadPer10k: rate.cacheReadPer10k.toFixed(),
          outputPer10k: rate.outputPer10k.toFixed(),
          offPeakShare: rate.offPeakShare.toFixed(),
          peak: rate.peak,
        })
  const demandRows = await prisma.$queryRaw<
    {
      slug: string | null
      workspaces: number
      weeklyLimits: number
      spent7d: number
      p95: number
    }[]
  >`
    WITH spaces AS (
      SELECT w.id, (SELECT p.slug FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.workspace_id = w.id AND s.status = 'active' LIMIT 1) AS slug,
        (SELECT p.credits_per_week FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.workspace_id = w.id AND s.status = 'active' LIMIT 1) AS week
      FROM workspaces w
      WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id = w.id
        AND t.created_at >= ${new Date(now.getTime() - 30 * 86_400_000)})
    ), spent AS (
      SELECT t.workspace_id, SUM(u.cost_rub / r.rub_per_credit) AS credits
      FROM token_usage u JOIN tasks t ON t.id = u.task_id
      CROSS JOIN LATERAL (SELECT c.rub_per_credit FROM credit_rates c
        WHERE c.effective_from <= u.occurred_at ORDER BY c.effective_from DESC LIMIT 1) r
      WHERE u.billable AND u.occurred_at >= ${new Date(now.getTime() - 7 * 86_400_000)}
      GROUP BY t.workspace_id
    ), windows AS (
      SELECT w.workspace_id, SUM(u.cost_rub / r.rub_per_credit) AS credits
      FROM workspace_usage_windows w
      JOIN tasks t ON t.workspace_id = w.workspace_id
      JOIN token_usage u ON u.task_id = t.id AND u.billable
        AND u.occurred_at >= w.started_at AND u.occurred_at < w.ends_at
      CROSS JOIN LATERAL (SELECT c.rub_per_credit FROM credit_rates c
        WHERE c.effective_from <= u.occurred_at ORDER BY c.effective_from DESC LIMIT 1) r
      WHERE w.kind = '5h' AND w.started_at >= ${new Date(now.getTime() - 7 * 86_400_000)}
      GROUP BY w.id, w.workspace_id
    )
    SELECT s.slug, count(DISTINCT s.id)::int AS workspaces,
      COALESCE(SUM(s.week), 0)::int AS "weeklyLimits",
      COALESCE((SELECT SUM(x.credits) FROM spent x WHERE x.workspace_id IN
        (SELECT id FROM spaces y WHERE y.slug IS NOT DISTINCT FROM s.slug)), 0)::float8 AS "spent7d",
      COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY x.credits) FROM windows x
        WHERE x.workspace_id IN (SELECT id FROM spaces y WHERE y.slug IS NOT DISTINCT FROM s.slug)),
        0)::float8 AS p95
    FROM spaces s GROUP BY s.slug`
  const demand = workspaceTiers.map((tier) => {
    const rows = demandRows.filter((row) => tierOfSlug(row.slug) === tier)
    return {
      tier,
      workspaces: rows.reduce((total, row) => total + row.workspaces, 0),
      // A workspace without a tariff has the weekly limit of the constants.
      weeklyLimits: rows.reduce(
        (total, row) => total + (row.slug === null ? row.workspaces * 50 : row.weeklyLimits),
        0,
      ),
      spent7d: rows.reduce((total, row) => total + row.spent7d, 0),
      p95FiveHours: Math.max(0, ...rows.map((row) => row.p95)),
    }
  })
  return { now, accounts, hours, peakRates, demand }
}

const tierOfSlug = (slug: string | null): WorkspaceTier =>
  slug === null ? 'none' : slug === 'business' || slug === 'agency' ? slug : 'start'

const planRatesFileSchema = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        model: z.string().min(1).max(255),
        effectiveFrom: z.iso.datetime({ offset: true }),
        sourceUrl: z.url().max(1024),
        rates: planRatesSchema,
      }),
    )
    .min(1)
    .max(20),
})

async function runPlanRates(
  prisma: PrismaClient,
  args: readonly string[],
  write: Write,
): Promise<void> {
  const file = valueOf(args, '--file')
  const provider = valueOf(args, '--provider')
  if (file === undefined || provider === undefined)
    throw new Error('Укажите --file <файл ставок плана> и --provider <slug провайдера>.')
  if (statSync(file).size > 64 * 1024) throw new Error('Файл ставок плана слишком большой.')
  const parsed = planRatesFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) throw new Error('Файл ставок плана не читается: проверьте его поля.')
  const row = await prisma.llmProvider.findUnique({ where: { slug: provider } })
  if (row === null) throw new Error(`Провайдера ${provider} нет.`)
  for (const item of parsed.data.rows) {
    const effectiveFrom = new Date(item.effectiveFrom)
    const data = {
      inputUncachedPer10k: item.rates.inputUncachedPer10k,
      cacheReadPer10k: item.rates.cacheReadPer10k,
      outputPer10k: item.rates.outputPer10k,
      offPeakShare: item.rates.offPeakShare,
      peak: item.rates.peak,
      sourceUrl: item.sourceUrl,
    }
    const existing = await prisma.llmPlanRate.findUnique({
      where: {
        providerId_model_effectiveFrom: { providerId: row.id, model: item.model, effectiveFrom },
      },
    })
    if (existing !== null) {
      const same =
        existing.inputUncachedPer10k.equals(data.inputUncachedPer10k) &&
        existing.cacheReadPer10k.equals(data.cacheReadPer10k) &&
        existing.outputPer10k.equals(data.outputPer10k) &&
        existing.offPeakShare.equals(data.offPeakShare) &&
        samePeak(existing.peak, data.peak)
      if (!same)
        throw new Error(
          `Ставки ${item.model} с ${item.effectiveFrom} уже записаны с другими значениями: добавьте строку с новым моментом.`,
        )
      write(`${item.model} с ${item.effectiveFrom}: уже записано.\n`)
      continue
    }
    await prisma.llmPlanRate.create({
      data: { providerId: row.id, model: item.model, effectiveFrom, ...data },
    })
    write(`${item.model} с ${item.effectiveFrom}: записано.\n`)
  }
}

/** jsonb keeps its own order of keys: the peaks are compared field by field. */
function samePeak(stored: unknown, given: PlanRates['peak']): boolean {
  const peak = planRatesSchema.shape.peak.safeParse(stored)
  return (
    peak.success &&
    peak.data.timeZone === given.timeZone &&
    peak.data.fromHour === given.fromHour &&
    peak.data.toHour === given.toHour &&
    peak.data.days.join() === given.days.join()
  )
}

const valueOf = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

export async function runLlmCommand(
  command: 'usage' | 'plan-rates',
  args: readonly string[],
  env: Env = process.env,
  write: Write = (text) => void process.stdout.write(text),
): Promise<void> {
  if (!appEnvSchema.safeParse(env.APP_ENV).success)
    throw new Error('Задайте APP_ENV: development, test или production.')
  const prisma = createPrismaClient({ ...dbConfigFromEnv(env), log: [] })
  try {
    if (command === 'plan-rates') return await runPlanRates(prisma, args, write)
    const report = usageReport(await readFacts(prisma, new Date()))
    if (args.includes('--json')) write(`${JSON.stringify(report, null, 2)}\n`)
    else for (const line of usageReportText(report)) write(`${line}\n`)
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}
