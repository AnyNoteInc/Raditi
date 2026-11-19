'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
export default function Share() {
  const [len, setLen] = useState(-1)
  const router = useRouter()
  useEffect(() => { setLen(location.hash.length) }, [])
  return (<main><p id="len">{len}</p><Link id="tob" href="/b">b</Link><button id="toc" onClick={() => router.push('/c')}>c</button></main>)
}
