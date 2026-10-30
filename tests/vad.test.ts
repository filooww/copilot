import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/lib/api', () => ({ km: {} }))
import { Vad } from '../src/renderer/lib/audio'

const FRAME = 320

/** A "word": a voiced-like tone of the given RMS between stretches of faint room noise. */
function scene(wordMs: number, rms: number): Float32Array {
  const lead = 16000
  const word = (wordMs * 16) | 0
  const out = new Float32Array(lead + word + 24000)
  let seed = 7
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 16807) % 2147483647
    out[i] = ((seed / 2147483647) * 2 - 1) * 0.0008
  }
  for (let i = 0; i < word; i++) out[lead + i] += Math.sin((2 * Math.PI * 180 * i) / 16000) * rms * Math.SQRT2
  return out
}

function finals(sig: Float32Array): number {
  let n = 0
  const v = new Vad(
    () => {},
    () => n++
  )
  let t = 0
  for (let i = 0; i + FRAME <= sig.length; i += FRAME) v.push(sig.subarray(i, i + FRAME), (t += 20))
  v.flush()
  return n
}

describe('Vad sensitivity', () => {
  it('catches a short word', () => {
    expect(finals(scene(200, 0.03))).toBe(1)
  })

  it('catches a quiet voice', () => {
    expect(finals(scene(1500, 0.0035))).toBe(1)
  })

  it('stays silent on room noise alone', () => {
    expect(finals(scene(0, 0))).toBe(0)
  })

  it('ignores a click too short to be a word', () => {
    expect(finals(scene(40, 0.05))).toBe(0)
  })

  it('ends a phrase on room hum that sits above the absolute floor', () => {
    const sig = scene(1500, 0.03)
    let seed = 11
    for (let i = 16000 + 24000; i < sig.length; i++) {
      seed = (seed * 16807) % 2147483647
      sig[i] += ((seed / 2147483647) * 2 - 1) * 0.0025
    }
    const seen: number[] = []
    const v = new Vad(
      () => {},
      (u) => seen.push(u.pcm.length)
    )
    let t = 0
    for (let i = 0; i + FRAME <= sig.length; i += FRAME) v.push(sig.subarray(i, i + FRAME), (t += 20))
    expect(seen.length).toBe(1)
    expect(seen[0] / 16000).toBeLessThan(3)
  })
})
