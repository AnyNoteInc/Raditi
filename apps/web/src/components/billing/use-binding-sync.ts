'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useTRPC, useTRPCClient } from '@/trpc/client'

import type { BillingOverview } from './billing-types'

/**
 * Settles a binding of a payment method the subscription still waits for, for a page that shows
 * the method. A binding is stored when its notification arrives or when somebody asks about it;
 * a customer who confirmed the card and left before the return page had an answer comes here
 * next, so the page asks for them. Once per opening of the page, when the overview says that a
 * binding waits (`bindingPending`) and the shop can be asked: `billing.syncPaymentMethod` reads
 * the method back, and an outcome makes the overview be read anew — the card, or its refusal,
 * is then on the page. One look, never a loop: a binding the customer has not confirmed yet
 * stays waiting until the page is opened again, and a look that failed leaves the page as it
 * was, with what the overview said.
 */
export function useBindingSync(
  overview: Pick<BillingOverview, 'bindingPending' | 'paymentsEnabled'> | undefined,
): void {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const asked = useRef(false)
  // Without the shop there is nobody to ask, and the procedure would only refuse.
  const waits = overview?.bindingPending === true && overview.paymentsEnabled

  useEffect(() => {
    if (!waits || asked.current) return
    asked.current = true
    client.billing.syncPaymentMethod.mutate({}).then(
      (binding) => {
        // Still waiting: nothing changed, and reading the overview anew would tell the same.
        if (binding.state === 'pending') return
        void queryClient.invalidateQueries({ queryKey: trpc.billing.overview.queryKey() })
      },
      () => {
        // Not the customer's errand: the page goes on showing the method it knows of.
      },
    )
  }, [waits, client, queryClient, trpc])
}
