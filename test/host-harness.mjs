/**
 * Standalone harness for the dsh-lens Host half.
 *
 * Runs `apply()` against a fake Cordis context, mounts the API route on a real
 * loopback server and exercises the two methods the client depends on:
 * `detect` (workspace-scoped discovery) and `preview` (the loopback proxy).
 *
 *   node test/host-harness.mjs detect <workspaceDir>
 *   node test/host-harness.mjs preview <url> [workspaceDir]
 */
import http from 'node:http'
import { apply } from '../lib/index.js'

const handlers = []
const disposers = []
const ctx = {
  webServer: {
    register(entry) {
      handlers.push(entry.handler)
      return () => handlers.splice(handlers.indexOf(entry.handler), 1)
    },
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  logger: () => ({ info: (message) => console.log('[host]', message) }),
}
apply(ctx, { debug: true })

const server = http.createServer((req, res) => {
  if (handlers.length && req.url.startsWith('/__dsh-lens')) {
    void handlers[0](req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('harness: not the plugin route')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const call = async (method, args) => {
  const res = await fetch(origin + '/__dsh-lens/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  return { status: res.status, body: await res.json() }
}

const [mode, target, root] = process.argv.slice(2)
if (mode === 'detect') {
  const result = await call('detect', { sid: 'harness', root: target, force: true })
  console.log(JSON.stringify({ status: result.status, ...result.body }, null, 2))
} else if (mode === 'preview') {
  const result = await call('preview', { sid: 'harness', url: target, root, lease: 'lease-1' })
  console.log('API', result.status, JSON.stringify(result.body))
  if (result.body.ok) {
    const page = await fetch(result.body.url)
    const text = await page.text()
    console.log('PAGE', page.status, 'bytes', text.length)
    console.log('has config', text.includes('window.__DSH_LENS__='))
    console.log('has shim', text.includes('__dshLensState'))
    console.log('has overlay', text.includes('__dshLensReady'))
    console.log('preview origin', result.body.origin)
    console.log('frame url', result.body.url)
    // Keep the harness alive long enough for a browser to use the preview.
    if (process.env.LENS_KEEP === '1') {
      console.log('keeping harness alive; Ctrl+C to stop')
      await new Promise(() => {})
    }
  }
} else {
  console.error('usage: node test/host-harness.mjs detect <workspaceDir> | preview <url> [workspaceDir]')
  process.exit(2)
}
for (const dispose of disposers) dispose()
server.close()
