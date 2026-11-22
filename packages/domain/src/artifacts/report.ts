import { z } from 'zod'

// «Отчёт» (docs/plan/88-artifacts.md, §7.13, Э11, slice 88.28): sections of Markdown, charts and a
// table in the order of their blocks. A chart is not the options of ECharts — a narrow spec of its
// own: a kind, the categories and up to eight series of numbers. The server draws it into an SVG
// (ECharts, `renderToSVGString`); nothing of the client's runs.

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (text) =>
        [...text].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f),
      'one line',
    )

export const artifactChartKinds = ['bar', 'line', 'pie'] as const
export type ArtifactChartKind = (typeof artifactChartKinds)[number]

export const artifactChartLimits = Object.freeze({
  categories: 50,
  series: 8,
  width: 720,
  height: 360,
})

export const artifactChartSpecSchema = z
  .strictObject({
    type: z.enum(artifactChartKinds),
    title: line(120).optional(),
    /** The labels of the axis, or of the slices of a pie. */
    categories: z.array(line(60)).min(1).max(artifactChartLimits.categories),
    series: z
      .array(
        z.strictObject({
          name: line(60),
          values: z.array(z.number().finite()).max(artifactChartLimits.categories),
        }),
      )
      .min(1)
      .max(artifactChartLimits.series),
    /** The unit of the values: «₽», «шт.», «%». */
    unit: line(12).optional(),
    /** Bars of the series one on another. */
    stacked: z.boolean().optional(),
  })
  .refine(
    (spec) => spec.series.every((series) => series.values.length === spec.categories.length),
    'each series has a value a category',
  )
  .refine((spec) => spec.type !== 'pie' || spec.series.length === 1, 'a pie is one series')
  .refine(
    (spec) => spec.type !== 'pie' || spec.series[0]!.values.every((value) => value >= 0),
    'a pie has no negative slice',
  )
export type ArtifactChartSpec = z.infer<typeof artifactChartSpecSchema>

/** The spec of a chart block, or null with what is wrong — in English, for the agent. */
export function artifactChartOf(
  content: string | null,
): { ok: true; spec: ArtifactChartSpec } | { ok: false; problem: string } {
  if (content === null || content.trim() === '') return { ok: false, problem: 'empty' }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return { ok: false, problem: 'not JSON' }
  }
  const parsed = artifactChartSpecSchema.safeParse(value)
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : {
        ok: false,
        problem: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'chart'}: ${issue.message}`)
          .join('; '),
      }
}
