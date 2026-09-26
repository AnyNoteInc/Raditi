import { Injectable } from '@nestjs/common'
import {
  assertTransition,
  canTransition,
  nextStatuses,
  terminalTaskStatuses,
  type TaskStatus,
} from '@repo/domain'

/**
 * The task state machine of spec §7, still without storage: the rules live in @repo/domain.
 * TODO(P12): conditional UPDATE … WHERE status IN (…) together with credit_ledger.
 */
@Injectable()
export class TaskLifecycleService {
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return canTransition(from, to)
  }

  /** Throws a CONFLICT DomainError for a transition the state machine does not allow. */
  assertTransition(from: TaskStatus, to: TaskStatus): void {
    assertTransition(from, to)
  }

  nextStatuses(from: TaskStatus): readonly TaskStatus[] {
    return nextStatuses(from)
  }

  isTerminal(status: TaskStatus): boolean {
    return terminalTaskStatuses.includes(status)
  }
}
