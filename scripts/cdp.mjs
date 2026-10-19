// Tiny Chrome DevTools Protocol helper used for smoke-testing the running app.
// Usage: node scripts/cdp.mjs <port> <command> [args]
//   eval "<js>"            evaluate JS in the renderer, print JSON result
//   shot <file.png>        capture a screenshot
//   key <Key> [count]      send a key press (e.g. ArrowRight, Enter, Escape, f)
// Start the app with: npx electron . --remote-debugging-port=9333

const [port = '9333', cmd, ...args] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

const KEYS = {
  ArrowRight: 39,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowDown: 40,
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  PageDown: 34,
  PageUp: 33
}

if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2))
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(args[0], Buffer.from(r.result.data, 'base64'))
  console.log('saved', args[0])
} else if (cmd === 'key') {
  const key = args[0]
  const n = Number(args[1] ?? 1)
  for (let i = 0; i < n; i++) {
    const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0)
    const text = key.length === 1 ? key : undefined
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, text })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code })
    await new Promise((r) => setTimeout(r, 120))
  }
  console.log('ok')
}
ws.close()
