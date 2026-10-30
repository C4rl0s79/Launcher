import type { BrowserWindow } from 'electron'
import { log } from '../logger'
import type { PadState } from '@shared/types'
import { axis, hatDirection, layoutFor, toPadState, type HidSnapshot, type Layout } from './hidLayout'

// Pads that are not XInput devices (DualShock 4 / DualSense / Switch Pro, GameSir or 8BitDo in
// Bluetooth HID mode) through Raw Input: Windows hands Lumen's window a copy of every report the
// pad sends anyway. Nothing is opened or written to the pad (no LED / rumble / mode reports), so
// this keeps the promise of the XInput poller: Lumen never initialises or wakes a controller.
// Pads XInput already reports (device path with "IG_") are skipped, so none counts twice.

const WM_INPUT = 0x00ff
const WM_INPUT_DEVICE_CHANGE = 0x00fe
const GIDC_REMOVAL = 2
const RID_INPUT = 0x10000003
const RIM_TYPEHID = 2
const RIDI_PREPARSEDDATA = 0x20000005
const RIDI_DEVICENAME = 0x20000007
const RIDI_DEVICEINFO = 0x2000000b
const RIDEV_REMOVE = 0x00000001
const RIDEV_INPUTSINK = 0x00000100
const RIDEV_DEVNOTIFY = 0x00002000
const HIDP_INPUT = 0
const HIDP_STATUS_SUCCESS = 0x00110000
const PAGE_DESKTOP = 0x01
const PAGE_BUTTON = 0x09
const USAGE_X = 0x30
const USAGE_Y = 0x31
const USAGE_HAT = 0x39
// top-level collections of game controllers: joystick, gamepad
const USAGES = [0x04, 0x05]
// HIDP_CAPS / HIDP_VALUE_CAPS / HIDP_BUTTON_CAPS sizes (x64)
const CAPS_SIZE = 64
const ITEM_CAPS_SIZE = 72
const HEADER_SIZE = 24 // RAWINPUTHEADER on x64

interface ValueCap {
  link: number
  min: number
  max: number
  bits: number
}

interface Device {
  skip: boolean
  index: number
  name: string
  preparsed?: Buffer
  layout?: Layout
  values?: Map<number, ValueCap>
  maxUsages?: number
  last?: Buffer
  state?: PadState
}

type Native = {
  register(hwnd: bigint, flags: number): boolean
  inputData(handle: bigint): Buffer | null
  deviceName(handle: bigint): string
  deviceIds(handle: bigint): { vid: number; pid: number }
  preparsed(handle: bigint): Buffer | null
  caps(pre: Buffer): Buffer | null
  valueCaps(pre: Buffer, n: number): Buffer | null
  buttonCaps(pre: Buffer, n: number): Buffer | null
  maxUsages(pre: Buffer): number
  usages(pre: Buffer, report: Buffer, max: number): number[] | null
  value(pre: Buffer, report: Buffer, usage: number, link: number): number | null
}

function loadNative(): Native | null {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const u = koffi.load('user32.dll')
    const h = koffi.load('hid.dll')
    const RID = koffi.struct('LUMEN_RAWINPUTDEVICE', { usUsagePage: 'uint16', usUsage: 'uint16', dwFlags: 'uint32', hwndTarget: 'intptr' })
    const register = u.func('__stdcall', 'RegisterRawInputDevices', 'int32', [koffi.pointer(RID), 'uint32', 'uint32'])
    const getData = u.func('__stdcall', 'GetRawInputData', 'uint32', ['intptr', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32')), 'uint32'])
    const getInfo = u.func('__stdcall', 'GetRawInputDeviceInfoW', 'uint32', ['intptr', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))])
    const getCaps = h.func('__stdcall', 'HidP_GetCaps', 'int32', ['void *', 'void *'])
    const getValueCaps = h.func('__stdcall', 'HidP_GetValueCaps', 'int32', ['int32', 'void *', koffi.inout(koffi.pointer('uint16')), 'void *'])
    const getButtonCaps = h.func('__stdcall', 'HidP_GetButtonCaps', 'int32', ['int32', 'void *', koffi.inout(koffi.pointer('uint16')), 'void *'])
    const maxList = h.func('__stdcall', 'HidP_MaxUsageListLength', 'uint32', ['int32', 'uint16', 'void *'])
    const getUsages = h.func('__stdcall', 'HidP_GetUsages', 'int32', [
      'int32',
      'uint16',
      'uint16',
      'void *',
      koffi.inout(koffi.pointer('uint32')),
      'void *',
      'void *',
      'uint32'
    ])
    const getValue = h.func('__stdcall', 'HidP_GetUsageValue', 'int32', [
      'int32',
      'uint16',
      'uint16',
      'uint16',
      koffi.out(koffi.pointer('uint32')),
      'void *',
      'void *',
      'uint32'
    ])
    const ok = (s: number): boolean => s >>> 0 === HIDP_STATUS_SUCCESS
    const info = (handle: bigint, cmd: number, unit: number): Buffer | null => {
      const size = [0]
      getInfo(handle, cmd, null, size)
      if (!size[0]) return null
      const buf = Buffer.alloc(size[0] * unit)
      if (cmd === RIDI_DEVICEINFO) buf.writeUInt32LE(buf.length, 0)
      return (getInfo(handle, cmd, buf, size) as number) === 0xffffffff ? null : buf
    }
    return {
      register: (hwnd, flags) =>
        USAGES.every(
          (usage) => !!register({ usUsagePage: PAGE_DESKTOP, usUsage: usage, dwFlags: flags, hwndTarget: flags & RIDEV_REMOVE ? 0n : hwnd }, 1, 16)
        ),
      inputData: (handle) => {
        const size = [0]
        getData(handle, RID_INPUT, null, size, HEADER_SIZE)
        if (!size[0]) return null
        const buf = Buffer.alloc(size[0])
        return (getData(handle, RID_INPUT, buf, size, HEADER_SIZE) as number) === 0xffffffff ? null : buf
      },
      deviceName: (handle) => info(handle, RIDI_DEVICENAME, 2)?.toString('utf16le').replace(/\0.*$/s, '') ?? '',
      deviceIds: (handle) => {
        const b = info(handle, RIDI_DEVICEINFO, 1)
        // RID_DEVICE_INFO: cbSize, dwType, then RID_DEVICE_INFO_HID: dwVendorId, dwProductId…
        return b && b.readUInt32LE(4) === RIM_TYPEHID ? { vid: b.readUInt32LE(8), pid: b.readUInt32LE(12) } : { vid: 0, pid: 0 }
      },
      preparsed: (handle) => info(handle, RIDI_PREPARSEDDATA, 1),
      caps: (pre) => {
        const b = Buffer.alloc(CAPS_SIZE)
        return ok(getCaps(pre, b) as number) ? b : null
      },
      valueCaps: (pre, n) => {
        const b = Buffer.alloc(ITEM_CAPS_SIZE * n)
        return n && ok(getValueCaps(HIDP_INPUT, b, [n], pre) as number) ? b : null
      },
      buttonCaps: (pre, n) => {
        const b = Buffer.alloc(ITEM_CAPS_SIZE * n)
        return n && ok(getButtonCaps(HIDP_INPUT, b, [n], pre) as number) ? b : null
      },
      maxUsages: (pre) => maxList(HIDP_INPUT, PAGE_BUTTON, pre) as number,
      usages: (pre, report, max) => {
        const list = Buffer.alloc(Math.max(1, max) * 2)
        const len = [max]
        if (!ok(getUsages(HIDP_INPUT, PAGE_BUTTON, 0, list, len, pre, report, report.length) as number)) return null
        return Array.from({ length: len[0] }, (_, i) => list.readUInt16LE(i * 2))
      },
      value: (pre, report, usage, link) => {
        const v = [0]
        return ok(getValue(HIDP_INPUT, PAGE_DESKTOP, link, usage, v, pre, report, report.length) as number) ? v[0] : null
      }
    }
  } catch (e) {
    log.warn('input', `HID pads unavailable: ${(e as Error).message}`)
    return null
  }
}

const pointer = (b: Buffer): bigint => (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0)))

/** Value caps of the axes Lumen uses (X, Y, hat), by usage. */
function readValueCaps(buf: Buffer | null, n: number): Map<number, ValueCap> {
  const out = new Map<number, ValueCap>()
  for (let i = 0; buf && i < n; i++) {
    const o = i * ITEM_CAPS_SIZE
    if (buf.readUInt16LE(o) !== PAGE_DESKTOP) continue
    const isRange = !!buf.readUInt8(o + 12)
    const lo = buf.readUInt16LE(o + 56)
    const hi = isRange ? buf.readUInt16LE(o + 58) : lo
    const cap = { link: buf.readUInt16LE(o + 6), bits: buf.readUInt16LE(o + 18), min: buf.readInt32LE(o + 40), max: buf.readInt32LE(o + 44) }
    for (const usage of [USAGE_X, USAGE_Y, USAGE_HAT]) if (usage >= lo && usage <= hi && !out.has(usage)) out.set(usage, cap)
  }
  return out
}

/** Highest button number the pad declares. */
function buttonCount(buf: Buffer | null, n: number): number {
  let top = 0
  for (let i = 0; buf && i < n; i++) {
    const o = i * ITEM_CAPS_SIZE
    if (buf.readUInt16LE(o) !== PAGE_BUTTON) continue
    const isRange = !!buf.readUInt8(o + 12)
    top = Math.max(top, buf.readUInt16LE(o + (isRange ? 58 : 56)))
  }
  return top
}

export class RawHidPads {
  private native = loadNative()
  private devices = new Map<bigint, Device>()
  private nextIndex = 4 // 0–3 are the XInput slots
  private win: BrowserWindow | null = null
  private debug = process.env.LUMEN_PAD_DEBUG === '1'

  get available(): boolean {
    return !!this.native
  }

  /** Starts receiving HID pad reports in `win` (also while it is in the background — the poller decides when they count). */
  attach(win: BrowserWindow): void {
    if (!this.native || this.win) return
    const hwnd = pointer(win.getNativeWindowHandle())
    if (!this.native.register(hwnd, RIDEV_INPUTSINK | RIDEV_DEVNOTIFY)) {
      log.warn('input', 'HID pads: RegisterRawInputDevices failed')
      return
    }
    this.win = win
    win.hookWindowMessage(WM_INPUT, (_w, l) => this.onInput(pointer(l)))
    win.hookWindowMessage(WM_INPUT_DEVICE_CHANGE, (w, l) => {
      if (Number(pointer(w)) === GIDC_REMOVAL) this.devices.delete(pointer(l))
    })
    win.once('closed', () => {
      this.win = null
      this.devices.clear()
    })
    log.info('input', 'HID pads (PlayStation, Nintendo, Bluetooth HID) via Raw Input')
  }

  detach(): void {
    if (!this.native || !this.win) return
    if (!this.win.isDestroyed()) {
      this.win.unhookWindowMessage(WM_INPUT)
      this.win.unhookWindowMessage(WM_INPUT_DEVICE_CHANGE)
    }
    this.native.register(0n, RIDEV_REMOVE)
    this.win = null
    this.devices.clear()
  }

  /** Current state of every HID pad that has sent a report. */
  pads(): PadState[] {
    const out: PadState[] = []
    for (const d of this.devices.values()) if (d.state) out.push(d.state)
    return out
  }

  private onInput(handle: bigint): void {
    try {
      const n = this.native!
      const data = n.inputData(handle)
      if (!data || data.readUInt32LE(0) !== RIM_TYPEHID) return
      const dev = this.device(pointer(data.subarray(8, 16)))
      if (dev.skip || !dev.preparsed) return
      // RAWHID: dwSizeHid, dwCount, then dwCount reports — the newest one counts
      const size = data.readUInt32LE(HEADER_SIZE)
      const count = data.readUInt32LE(HEADER_SIZE + 4)
      if (!size || !count) return
      const start = HEADER_SIZE + 8 + (count - 1) * size
      const report = data.subarray(start, start + size)
      if (dev.last && dev.last.equals(report)) return
      dev.last = Buffer.from(report)
      const snap = this.decode(dev, report)
      if (!snap) return
      dev.state = toPadState(dev.index, snap, dev.layout!)
      if (this.debug)
        log.info(
          'input',
          `HID ${dev.name}: przyciski [${snap.buttons.join(',')}] hat ${snap.hat ?? '-'} x ${snap.x?.toFixed(2)} y ${snap.y?.toFixed(2)}`
        )
    } catch (e) {
      log.warn('input', `HID pad report: ${(e as Error).message}`)
    }
  }

  private decode(dev: Device, report: Buffer): HidSnapshot | null {
    const n = this.native!
    const pre = dev.preparsed!
    const buttons = n.usages(pre, report, dev.maxUsages ?? 32)
    if (!buttons) return null // a report without the pad's buttons (e.g. a vendor-specific one)
    const read = (usage: number): number | null => {
      const cap = dev.values!.get(usage)
      if (!cap) return null
      let v = n.value(pre, report, usage, cap.link)
      if (v === null) return null
      // signed ranges come back as raw bits
      if (cap.min < 0 && cap.bits > 0 && cap.bits < 32 && v >= 2 ** (cap.bits - 1)) v -= 2 ** cap.bits
      return v
    }
    const cx = dev.values!.get(USAGE_X)
    const cy = dev.values!.get(USAGE_Y)
    const ch = dev.values!.get(USAGE_HAT)
    const x = read(USAGE_X)
    const y = read(USAGE_Y)
    const h = read(USAGE_HAT)
    return {
      buttons,
      x: x !== null && cx ? axis(x, cx.min, cx.max) : undefined,
      y: y !== null && cy ? axis(y, cy.min, cy.max) : undefined,
      hat: h !== null && ch ? hatDirection(h, ch.min, ch.max) : null
    }
  }

  private device(handle: bigint): Device {
    const known = this.devices.get(handle)
    if (known) return known
    const n = this.native!
    const name = n.deviceName(handle)
    const dev: Device = { skip: true, index: -1, name }
    this.devices.set(handle, dev)
    if (/IG_/i.test(name)) return dev // an XInput pad — read by the XInput poller
    const { vid, pid } = n.deviceIds(handle)
    const pre = n.preparsed(handle)
    const caps = pre && n.caps(pre)
    if (!pre || !caps) return dev
    const nButtonCaps = caps.readUInt16LE(46)
    const nValueCaps = caps.readUInt16LE(48)
    const buttons = buttonCount(n.buttonCaps(pre, nButtonCaps), nButtonCaps)
    if (!buttons) return dev
    const hex = (v: number): string => v.toString(16).padStart(4, '0')
    Object.assign(dev, {
      skip: false,
      index: this.nextIndex++,
      name: `${hex(vid)}:${hex(pid)}`,
      preparsed: pre,
      layout: layoutFor(vid, buttons),
      values: readValueCaps(n.valueCaps(pre, nValueCaps), nValueCaps),
      maxUsages: n.maxUsages(pre) || buttons
    })
    log.info('input', `HID pad ${dev.name}: ${buttons} przycisków, układ ${dev.layout!.name}`)
    return dev
  }
}
