import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, easyMacShortcuts } from '../src/main/storage/settings'

describe('easyMacShortcuts', () => {
  const old = { ...DEFAULT_SETTINGS.shortcuts, answerNow: 'Control+Alt+A', solveScreen: 'Control+Alt+X', toggleAuto: 'Control+Alt+Q' }

  it('moves the old defaults to digits and leaves the rest alone', () => {
    expect(easyMacShortcuts(old)).toMatchObject({ answerNow: 'Control+1', solveScreen: 'Control+2', toggleAuto: 'Control+5' })
    expect(easyMacShortcuts(old).panic).toBeUndefined()
  })

  it('keeps a hotkey the user picked', () => {
    expect(easyMacShortcuts({ ...old, answerNow: 'Control+Alt+J' }).answerNow).toBeUndefined()
  })
})
