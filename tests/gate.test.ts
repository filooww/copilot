import { describe, expect, it } from 'vitest'
import { levelForGate } from '../src/main/asr/silero'

describe('levelForGate', () => {
  it('raises a quiet clip to a usable level', () => {
    const out = levelForGate(Int16Array.from([100, -200, 150]))
    expect(Math.max(...out.map(Math.abs))).toBe(8000)
  })

  it('stops at the gain limit, so faint hiss is not blown up to full scale', () => {
    expect(levelForGate(Int16Array.from([10, -10]))[0]).toBe(400)
  })

  it('leaves a loud clip untouched', () => {
    const pcm = Int16Array.from([20000, -20000])
    expect(levelForGate(pcm)).toBe(pcm)
  })
})
