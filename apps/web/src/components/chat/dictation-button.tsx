'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { createContext, useContext } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { dictationText, useDictation } from './dictation'

/**
 * Whether dictation is set up here (SpeechKit, docs/plan/75, ВВ16): the server page says it, the
 * fields below it — the notes of artifacts (docs/plan/88-artifacts.md, Ар53) — read it.
 */
export const DictationAvailable = createContext(false)

/**
 * The microphone of a field other than the chat's: «Надиктовать», then «Остановить запись» puts
 * the words after what is written (ВВ16). Nothing where dictation is not set up.
 */
export function DictationButton({
  disabled = false,
  onWords,
}: {
  disabled?: boolean
  onWords: (words: string) => void
}) {
  const available = useContext(DictationAvailable)
  const dictation = useDictation()
  if (!available) return null
  const recording = dictation.state === 'recording'
  async function stop() {
    const words = await dictation.finish()
    if (words) onWords(words)
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <IconButton
        size="small"
        aria-label={recording ? dictationText.stop : dictationText.start}
        aria-pressed={recording}
        disabled={disabled || dictation.state === 'recognizing'}
        onClick={() => (recording ? void stop() : void dictation.start())}
        sx={recording ? { color: 'error.main' } : undefined}
      >
        <AppIcon name={recording ? 'square' : 'microphone'} size={18} />
      </IconButton>
      <Typography variant="caption" color="text.secondary" role="status">
        {dictation.state === 'recording'
          ? dictationText.recording(dictation.seconds)
          : dictation.state === 'recognizing'
            ? dictationText.recognizing
            : (dictation.notice ?? '')}
      </Typography>
    </Box>
  )
}

/** The words of a dictation after what is written, a space between (ВВ16). */
export const withDictatedWords = (written: string, words: string): string =>
  written.trim() === '' ? words : `${written.trimEnd()} ${words}`
