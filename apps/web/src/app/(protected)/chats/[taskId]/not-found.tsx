'use client'

import { DialogNotFound } from '@/components/chat/dialog-not-found'

/** A chat the server does not find (`loadChat` calls `notFound`): it says the chat is gone. */
export default function NotFound() {
  return <DialogNotFound />
}
