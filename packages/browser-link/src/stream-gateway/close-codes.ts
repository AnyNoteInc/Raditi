// WebSocket close codes of the stream gateway (docs/plan/57-browser-tasks.md, Б12, §3.6). They live
// in domain, where the cabinet reads them too; the gateway closes with them.
export { browserStreamCloseCode, browserStreamCloseCodes } from '@repo/domain'
