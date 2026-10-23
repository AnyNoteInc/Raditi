import { Module } from '@nestjs/common'

import { AccessModule } from '../access/access.module.ts'
import { PreviewEntry } from './entry.ts'
import { PreviewGatewayServer } from './preview-gateway.server.ts'
import { PreviewProxy } from './proxy.ts'
import { PreviewTunnels } from './tunnels.ts'

/**
 * The gateway of previews: its own node:http server (PreviewGatewayServer), which startPreview
 * opens, and the parts it hands requests to. Only the server has a shutdown hook: its close()
 * stops the parts in its own order.
 */
@Module({
  imports: [AccessModule],
  providers: [PreviewGatewayServer, PreviewEntry, PreviewProxy, PreviewTunnels],
  exports: [PreviewGatewayServer],
})
export class GatewayModule {}
