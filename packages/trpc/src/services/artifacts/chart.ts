import { readArtifact, type PrismaClient } from '@repo/db'
import { chartSvg } from '@repo/doc-render/chart'
import { artifactChartOf, artifactNotFound } from '@repo/domain/artifacts'

// The picture of a chart of «Отчёт» for a reader (docs/plan/88-artifacts.md, §7.13, 88.28): the
// checked spec of the block, drawn by ECharts on the server — never the agent's text before the
// check, never ECharts in the cabinet.

export type ReportChartView =
  { state: 'drawn'; svg: string; width: number; height: number } | { state: 'failed' }

export async function reportChart(
  db: PrismaClient,
  input: { userId: string; artifactId: string; block: string },
): Promise<ReportChartView> {
  const artifact = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: { kind: 'user', userId: input.userId },
  })
  const block = artifact.blocks.find((each) => each.key === input.block && each.kind === 'chart')
  if (!block) throw artifactNotFound()
  const chart = artifactChartOf(block.content)
  if (!chart.ok) return { state: 'failed' }
  return { state: 'drawn', ...chartSvg(chart.spec) }
}
