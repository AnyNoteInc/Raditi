import { Controller, UseGuards } from '@nestjs/common'
import { StreamableHttpController } from '@rekog/mcp-nest'

import { McpAuthGuard } from '../access/mcp-auth.guard.ts'

/** All three HTTP verbs pass through the guard; the transport never self-mounts. */
@Controller('mcp')
@UseGuards(McpAuthGuard)
export class McpHttpController extends StreamableHttpController {}
