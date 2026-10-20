/**
 * Tiny static server for the annotation sandbox page.
 *
 *   node test/demo/serve.mjs [port]
 *
 * It exists so the page is a real loopback dev server started from this
 * workspace: dsh-lens can then prove the service belongs to the workspace (the
 * command line names a script inside it) and list it without being told a URL.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.argv[2] || process.env.PORT || 4180)
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
  const file = join(root, normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[\\/])+/, ''))
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(String(error.message || error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log('dsh-lens annotation sandbox: http://127.0.0.1:' + port + '/')
})
