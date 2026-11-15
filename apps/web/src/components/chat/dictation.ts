'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Dictation into the field of a chat (docs/plan/75-chat-input-output.md, ВВ16–ВВ19). The browser
// records the microphone itself — no recognition of the browser: Chrome would send the sound to
// Google (rule 1) — as PCM, 16 kHz, mono, 16 bits, at most 30 seconds, and the cabinet's route
// gives it to SpeechKit. The words go into the field; the client changes and sends them.

export const DICTATION_MAX_SECONDS = 30
const RATE = 16_000

export const dictationText = Object.freeze({
  start: 'Надиктовать',
  stop: 'Остановить запись',
  recognizing: 'Распознаём речь…',
  denied: 'Браузер не дал доступ к микрофону. Разрешите его в настройках сайта в браузере.',
  unsupported: 'Этот браузер не умеет записывать звук.',
  failed: 'Не удалось распознать речь. Попробуйте ещё раз.',
  recording: (seconds: number) => `Идёт запись, ${seconds} с из ${DICTATION_MAX_SECONDS}`,
})

/** The worklet that hands the samples of the microphone to the page, as they come. */
const WORKLET = `
class Collector extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('raditi-collector', Collector)
`

/** Float samples at `rate` as little-endian 16-bit PCM at 16 kHz: what SpeechKit takes. */
export function toPcm16(chunks: readonly Float32Array[], rate: number): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  const ratio = rate / RATE
  const length = Math.min(Math.floor(total / ratio), RATE * DICTATION_MAX_SECONDS)
  const view = new DataView(new ArrayBuffer(length * 2))
  for (let index = 0; index < length; index++) {
    // The nearest earlier sample: a dictation needs words, not hi-fi.
    const sample = joined[Math.floor(index * ratio)] ?? 0
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return view.buffer
}

interface Recording {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  chunks: Float32Array[]
  timer: number
  /** The frame of the wave: its levels are read again on every frame while recording. */
  frame: number
}

/** How many bars the wave of a recording has. */
export const WAVE_BARS = 24

/** The loudness of each part of the samples, 0–1: what the bars of the wave show. */
export function waveLevels(samples: Uint8Array, bars: number = WAVE_BARS): number[] {
  const size = Math.max(1, Math.floor(samples.length / bars))
  const levels: number[] = []
  for (let bar = 0; bar < bars; bar++) {
    let peak = 0
    for (let index = bar * size; index < Math.min(samples.length, (bar + 1) * size); index++)
      peak = Math.max(peak, Math.abs((samples[index] ?? 128) - 128) / 128)
    levels.push(Math.min(1, peak * 1.6))
  }
  return levels
}

export type DictationState = 'idle' | 'recording' | 'recognizing'

/** Records, sends and gives back the words; `notice` says why it did not. */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0))
  const recording = useRef<Recording | null>(null)

  const finish = useCallback(async () => {
    const current = recording.current
    if (!current) return
    recording.current = null
    window.clearInterval(current.timer)
    window.cancelAnimationFrame(current.frame)
    setLevels(Array(WAVE_BARS).fill(0))
    current.node.port.onmessage = null
    current.node.disconnect()
    for (const track of current.stream.getTracks()) track.stop()
    const sound = toPcm16(current.chunks, current.context.sampleRate)
    await current.context.close().catch(() => {})
    setState('recognizing')
    try {
      const response = await fetch('/api/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: sound,
      })
      const answer = (await response.json().catch(() => ({}))) as {
        text?: string
        message?: string
      }
      if (response.ok && answer.text) onText(answer.text)
      else setNotice(answer.message ?? dictationText.failed)
    } catch {
      setNotice(dictationText.failed)
    } finally {
      setState('idle')
      setSeconds(0)
    }
  }, [onText])

  const start = useCallback(async () => {
    setNotice(null)
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === 'undefined'
    ) {
      setNotice(dictationText.unsupported)
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      setNotice(dictationText.denied)
      return
    }
    let context: AudioContext
    try {
      context = new AudioContext({ sampleRate: RATE })
    } catch {
      // A browser that keeps its own rate: the samples are brought to 16 kHz when sent.
      context = new AudioContext()
    }
    const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    const node = new AudioWorkletNode(context, 'raditi-collector')
    const chunks: Float32Array[] = []
    node.port.onmessage = (event: MessageEvent<Float32Array>) => chunks.push(event.data)
    const source = context.createMediaStreamSource(stream)
    source.connect(node)
    // The wave of the recording: the loudness of the microphone, frame by frame.
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const draw = () => {
      analyser.getByteTimeDomainData(samples)
      setLevels(waveLevels(samples))
      if (recording.current) recording.current.frame = window.requestAnimationFrame(draw)
    }
    const began = Date.now()
    const timer = window.setInterval(() => {
      const passed = Math.floor((Date.now() - began) / 1000)
      setSeconds(passed)
      if (passed >= DICTATION_MAX_SECONDS) void finish()
    }, 250)
    recording.current = { stream, context, node, chunks, timer, frame: 0 }
    recording.current.frame = window.requestAnimationFrame(draw)
    setState('recording')
  }, [finish])

  // A page that goes away stops the microphone with it.
  useEffect(
    () => () => {
      const current = recording.current
      if (!current) return
      window.clearInterval(current.timer)
      window.cancelAnimationFrame(current.frame)
      for (const track of current.stream.getTracks()) track.stop()
      void current.context.close().catch(() => {})
    },
    [],
  )

  return {
    state,
    seconds,
    notice,
    levels,
    toggle: () =>
      state === 'recording' ? void finish() : state === 'idle' ? void start() : undefined,
  }
}
