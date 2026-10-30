import { describe, expect, it } from 'vitest'
import { axis, hatDirection, layoutFor, toPadState } from '../src/main/input/hidLayout'

const A = 0x1000
const B = 0x2000
const X = 0x4000
const Y = 0x8000
const BACK = 0x0020
const START = 0x0010

describe('HID pads → XInput-shaped state', () => {
  it('picks the layout by maker, then by button count', () => {
    expect(layoutFor(0x054c, 14).name).toBe('sony')
    expect(layoutFor(0x057e, 14).name).toBe('nintendo')
    expect(layoutFor(0x3537, 15).name).toBe('android')
    expect(layoutFor(0x1234, 12).name).toBe('sony')
    expect(layoutFor(0x1234, 10).name).toBe('xbox')
  })

  it('maps face buttons by position: bottom = A (confirm), right = B (back)', () => {
    const sony = layoutFor(0x054c, 14)
    expect(toPadState(4, { buttons: [2], hat: null }, sony).buttons).toBe(A) // Cross
    expect(toPadState(4, { buttons: [3], hat: null }, sony).buttons).toBe(B) // Circle
    expect(toPadState(4, { buttons: [1, 4], hat: null }, sony).buttons).toBe(X | Y)
    const nin = layoutFor(0x057e, 14)
    expect(toPadState(4, { buttons: [1], hat: null }, nin).buttons).toBe(A) // B printed, bottom
    expect(toPadState(4, { buttons: [2], hat: null }, nin).buttons).toBe(B) // A printed, right
  })

  it('Share/Options (Select/Start) give View + Start for the mode switch combo', () => {
    const s = toPadState(4, { buttons: [9, 10], hat: null }, layoutFor(0x054c, 14))
    expect(s.buttons).toBe(BACK | START)
    const a = toPadState(4, { buttons: [11, 12], hat: null }, layoutFor(0x3537, 15))
    expect(a.buttons).toBe(BACK | START)
  })

  it('trigger buttons become full triggers', () => {
    const s = toPadState(5, { buttons: [7, 8], hat: null }, layoutFor(0x054c, 14))
    expect([s.lt, s.rt]).toEqual([255, 255])
  })

  it('hat switch → d-pad, centred outside the range', () => {
    expect(hatDirection(0, 0, 7)).toBe(0)
    expect(hatDirection(8, 0, 7)).toBeNull()
    expect(hatDirection(0, 1, 8)).toBeNull()
    expect(hatDirection(3, 1, 8)).toBe(2)
    expect(hatDirection(1, 0, 3)).toBe(2)
    const xbox = layoutFor(0x1234, 10)
    expect(toPadState(4, { buttons: [], hat: 2 }, xbox).buttons).toBe(0x0008) // right
    expect(toPadState(4, { buttons: [], hat: 5 }, xbox).buttons).toBe(0x0002 | 0x0004) // down + left
  })

  it('axes: logical range → -1..1, Y flipped to XInput (up = positive)', () => {
    expect(axis(0, 0, 255)).toBe(-1)
    expect(axis(255, 0, 255)).toBe(1)
    expect(axis(-32768, -32768, 32767)).toBe(-1)
    const s = toPadState(4, { buttons: [], x: 1, y: -1, hat: null }, layoutFor(0x054c, 14))
    expect(s.lx).toBe(32767)
    expect(s.ly).toBe(32767)
  })
})
