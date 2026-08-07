'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'

// Client-only — ChatWidget uses browser-only APIs (SpeechRecognition,
// speechSynthesis) that don't exist during SSR anyway.
const ChatWidget = dynamic(() => import('./chat-widget').then((m) => m.ChatWidget), { ssr: false })

/**
 * Unity SEO Pre-Launch Hardening — Part K.3 (performance).
 *
 * The persistent marketplace assistant (this widget) previously mounted
 * unconditionally in the root layout on every single page, shipping its
 * full JS bundle (speech recognition/synthesis types, a chat transcript
 * UI) as part of every page's initial load. This wrapper defers actually
 * importing and mounting it until the browser is idle (or shortly after,
 * on browsers without requestIdleCallback), so it never competes with a
 * page's own initial render/interactivity.
 *
 * This is NOT the same feature as the real per-transaction chat
 * (src/components/messaging/chat-thread.tsx, Phase 3) — that one is
 * unaffected by this change, it's rendered directly on /chat and
 * transaction detail pages, not deferred here.
 */
export function AssistantWidgetLoader() {
  const [shouldLoad, setShouldLoad] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let idleHandle: number | undefined

    if ('requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(() => setShouldLoad(true), { timeout: 3000 })
    } else {
      // Safari has no requestIdleCallback — a short fixed delay is the safest equivalent.
      timeoutHandle = setTimeout(() => setShouldLoad(true), 2000)
    }

    // Also load immediately on the visitor's first real interaction —
    // never make someone who wants the assistant right away wait for idle.
    const onInteract = () => setShouldLoad(true)
    window.addEventListener('pointerdown', onInteract, { once: true, passive: true })
    window.addEventListener('keydown', onInteract, { once: true })

    return () => {
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle)
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      window.removeEventListener('pointerdown', onInteract)
      window.removeEventListener('keydown', onInteract)
    }
  }, [])

  if (!shouldLoad) return null
  return <ChatWidget />
}
