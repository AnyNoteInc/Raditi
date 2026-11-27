import { z } from 'zod'

// The built-in MCP servers of Raditi (docs/plan/99-vk-community.md, ВК15): tool families of the
// server `raditi` that a workspace turns on in «Настройки → Встроенные MCP». One that is off is not
// in a turn at all — not in `tools/list`, not in `tools/call`. The list grows: a new server is a row
// here, a family of mcp and its card in the cabinet, never a comparison of names elsewhere.

export const builtinMcpServers = ['vk'] as const
export type BuiltinMcpServer = (typeof builtinMcpServers)[number]
export const builtinMcpServerSchema = z.enum(builtinMcpServers)

export interface BuiltinMcpServerInfo {
  /** The name the client reads. */
  title: string
  /** One line of what the agent can do with it. */
  summary: string
  /** It is turned on only with a key the client gives (the key's own form opens). */
  needsKey: boolean
}

export const builtinMcpServerInfo: Readonly<Record<BuiltinMcpServer, BuiltinMcpServerInfo>> =
  Object.freeze({
    vk: Object.freeze({
      title: 'ВКонтакте',
      summary:
        'Агент готовит посты и ответы на комментарии в вашей группе, читает комментарии и считает статистику записей. Публикует только ваша кнопка.',
      needsKey: true,
    }),
  })
