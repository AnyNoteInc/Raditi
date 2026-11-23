import { Buffer } from 'node:buffer'

import { DomainError } from '@repo/domain'
import {
  artifactPrintLimits,
  type ArtifactPrintRequest,
  type ArtifactPrintResponse,
} from '@repo/domain/artifacts'

import type { RenderPool } from './render-pool.ts'

// «Скачать PDF» of «Отчёт» (docs/plan/88-artifacts.md, §7.13; slice 88.32): the page core assembled
// printed on a slot of the render pool, at most 8 MiB. Plain class: the stand loads it from its
// sources.

export class PrintService {
  readonly #pool: Pick<RenderPool, 'run'>

  constructor(pool: Pick<RenderPool, 'run'>) {
    this.#pool = pool
  }

  async print(request: ArtifactPrintRequest): Promise<ArtifactPrintResponse> {
    let pdf: Uint8Array
    try {
      pdf = await this.#pool.run((renderer) => renderer.print({ html: request.html }))
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('RENDER_UNAVAILABLE', 'The page was not printed', 503)
    }
    if (pdf.byteLength > artifactPrintLimits.pdfBytes)
      throw new DomainError('RENDER_TOO_LARGE', 'The printed file is over 8 MiB', 413)
    return { pdf: Buffer.from(pdf).toString('base64') }
  }
}
