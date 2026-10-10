/** The name the driver gives the platform's MCP server in the configuration of the CLI. */
export const mcpServer = 'raditi'

/**
 * The pinned CLI names a tool of an MCP server `<server>_<tool>`: for the model, in its
 * permission rules and in the rows it prints. The server is this driver's configuration and
 * nothing the core knows.
 */
export const mcpToolPrefix = `${mcpServer}_`

/**
 * The tool's own name for the common event, as every other driver reports a platform tool. A
 * tool of the CLI itself and a name that only begins with the same letters are left as they
 * are; the prefix is taken off once.
 */
export function platformToolName(tool: string): string {
  return tool.length > mcpToolPrefix.length && tool.startsWith(mcpToolPrefix)
    ? tool.slice(mcpToolPrefix.length)
    : tool
}
