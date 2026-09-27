// TurnCredentialSource for *.test.ts files: P2 has no durable store of turn credentials (P3, P6).
import type { TurnCredentialRef, TurnCredentialSource, TurnCredentialValues } from '@repo/domain'

const key = (turn: TurnCredentialRef) =>
  `${turn.taskId}:${turn.sessionId}:${turn.turn}:${turn.epoch}`

export class MemoryTurnCredentials implements TurnCredentialSource {
  readonly values = new Map<string, TurnCredentialValues>()
  readonly revoked: TurnCredentialRef[] = []
  recovered = 0

  async issue(turn: TurnCredentialRef): Promise<TurnCredentialValues> {
    const values = { llmApiKey: `llm-${key(turn)}`, mcpToken: `mcp-${key(turn)}` }
    this.values.set(key(turn), values)
    return values
  }

  /** Stores the values a turn was started with, as P3 would. */
  keep(turn: TurnCredentialRef, values: TurnCredentialValues): void {
    this.values.set(key(turn), values)
  }

  async recover(turn: TurnCredentialRef): Promise<TurnCredentialValues | null> {
    this.recovered += 1
    return this.values.get(key(turn)) ?? null
  }

  async revoke(turn: TurnCredentialRef): Promise<void> {
    this.values.delete(key(turn))
    this.revoked.push(turn)
  }
}
