/**
 * dsh-lens —Host half.
 *
 * One promise: a Codex-grade annotation surface for a local dev server that is
 * already running, scoped to the workspace you are working in.
 *
 *  1. `detect` —the loopback web servers that are really listening **and
 *     belong to this workspace**: the listening process was started from the
 *     workspace (its executable, its command line, or a script inside it), or
 *     the workspace declares that port. Everything else listening on this
 *     machine stays out of the list; a service nobody can claim is reachable by
 *     typing its URL, which the client remembers per workspace.
 *  2. A **loopback preview origin**: one ephemeral server per session/app, on
 *     `localhost` or `127.0.0.1` with a hostname different from the harness.
 *     The browser sees the app's own paths, so root-absolute scripts, styles and
 *     SPA routes work with no prefix, while the preview's DOM and web storage
 *     stay isolated from the harness. A shim and the overlay are injected into
 *     every HTML document, WebSocket upgrades are relayed per target, and
 *     cookies are namespaced and partitioned.
 *
 * The proxy itself (paths, cookies, WebSocket relay, framing headers) is carried
 * over from dsh-annotate, MIT, because that part is already right.
 *
 * The client reaches all of it at `POST /__dsh-lens/api`.
 */

import http from 'node:http'
import https from 'node:https'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-lens'

export const inject = ['webServer']

const ROUTE = '/__dsh-lens'
const WS_RELAY_PATH = '/__dsh_lens_ws'
const PREVIEW_IDLE_MS = 5 * 60_000

/** Where a built or hand-written page lives, relative to the session workspace,
 *  in the order they are offered. A static page needs no dev server at all. */
const STATIC_DIRS = ['', 'dist', 'build', 'out', 'public']
const STATIC_PAGE_LIMIT = 24
/** Bound on one static response, so a stray large file cannot be buffered into
 *  the proxy's memory. */
const STATIC_FILE_LIMIT = 64 * 1024 * 1024
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
const staticMime = (file) => STATIC_MIME[extname(file).toLowerCase()] || 'application/octet-stream'
const isHtmlFile = (file) => /\.html?$/i.test(file)

/** Both paths are absolute and already resolved, so a prefix test is exact. */
function insideRoot(target, root) {
  if (!target || !root) return false
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Dot segments are VCS metadata, environment files and editor state; none of
 *  them belong in a preview, and `..` fails this test too. */
const hasHiddenSegment = (pathname) => pathname.split('/').some((part) => part.startsWith('.'))

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
])

/** Headers that would stop a proxied page from being framed or injected. */
const UNFRAMEABLE = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
])

/** The page shim and the overlay, re-read on every HTML response. Reading per
 *  request instead of once per process is deliberate: editing either file is
 *  then one page refresh away, which is the whole development loop for the part
 *  of this plugin that runs inside the previewed app. A missing file degrades to
 *  no file rather than a blank page. */
function readInjected(file) {
  try {
    return readFileSync(new URL(file, import.meta.url), 'utf8')
  } catch (error) {
    console.warn('dsh-lens: cannot read ' + file, String((error && error.message) || error))
    return ''
  }
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
function isLocalTarget(url) {
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

const encodeTarget = (origin) => Buffer.from(origin, 'utf8').toString('base64url')
const decodeTarget = (value) => Buffer.from(String(value), 'base64url').toString('utf8')

/** `127.0.0.1:3099` -> 3099, `[::1]:3099` -> 3099, `localhost` -> 0.
 *  `String(host).split(':')[1]` is wrong for bracketed IPv6 literals. */
function hostPort(host) {
  const text = String(host || '')
  const close = text.lastIndexOf(']')
  const colon = text.lastIndexOf(':')
  if (colon === -1 || (close !== -1 && colon < close)) return 0
  const value = Number(text.slice(colon + 1))
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 0
}

/** The origin the browser actually used for this request. Behind a
 *  TLS-terminating reverse proxy the socket is plain http, so an explicit
 *  forwarded scheme wins over the socket. */
function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded : req.socket.encrypted ? 'https' : 'http'
  return `${scheme}://${req.headers.host}`
}

const originOf = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.host === 'app' && !url.username && !url.password ? 'dsh-app://app' : url.origin
  } catch (error) {
    void error
    return null
  }
}

function clearFrameKey(url) {
  if (!url.searchParams.has('__dsh_lens_key')) return
  // URLSearchParams.delete/set would normalize every other query value too,
  // changing full-URL annotation identities and signed application URLs.
  url.search = url.search.slice(1).split('&').filter((part) => !new URLSearchParams(part).has('__dsh_lens_key')).join('&')
}

function addFrameKey(url, key) {
  clearFrameKey(url)
  url.search += (url.search ? '&' : '?') + '__dsh_lens_key=' + encodeURIComponent(key)
}

/** A preview server must never become a readable gateway for an unrelated page.
 *  Chromium sends fetch metadata; Firefox and Safari send none, so fall back to
 *  the browser's own Origin/Referer. */
function allowedPreviewRequest(req, parentOrigin, previewOrigin) {
  const parents = [parentOrigin, previewOrigin]
  const fetchSite = req.headers['sec-fetch-site']
  const fetchDest = req.headers['sec-fetch-dest']
  if (fetchSite === 'cross-site' && fetchDest !== 'iframe') return false
  // A framed load can legitimately be cross-site (the harness may be on
  // 127.0.0.1 while the preview is on localhost), so it must name its parent.
  if (fetchDest === 'iframe' || fetchSite === 'cross-site') return parents.includes(originOf(req.headers.referer))
  if (fetchSite) return true
  // Browsers that send no fetch metadata still send Origin (for any readable
  // cross-origin request) or Referer. A page from anywhere else is rejected;
  // a request with no provenance at all is local tooling (curl, a test, a
  // health check), which cannot be told apart from a navigation and is allowed.
  const declared = originOf(req.headers.origin) || originOf(req.headers.referer)
  return declared === null || parents.includes(declared)
}

/** Only an existing absolute directory may be treated as a workspace. */
function existingDirectory(root) {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) return null
  try {
    const real = realpathSync(root)
    return statSync(real).isDirectory() ? real : null
  } catch (error) {
    void error
    return null
  }
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('request too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Run a one-shot command, never throwing. */
function run(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 4_000_000 }, (error, stdout) => {
      resolve(error && !stdout ? '' : String(stdout || ''))
    })
  })
}

/** Ports that are really listening, with the owning PID where the platform
 *  states one. Windows: `netstat -ano`; Linux: /proc; macOS/BSD: lsof.
 *  `pids` is what lets a service be claimed by the workspace it was started
 *  from, and a claim is the only way a service reaches the list. */
async function listeningPorts() {
  const ports = new Map() // port -> pid (0 = unknown)
  const accept = (port, pid) => {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return
    const owner = Number.isInteger(pid) && pid > 0 ? pid : 0
    if (!ports.has(port) || (ports.get(port) === 0 && owner)) ports.set(port, owner)
  }

  if (process.platform === 'win32') {
    const text = await run('netstat', ['-ano'])
    for (const line of text.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      // TCP    127.0.0.1:4173    0.0.0.0:0    LISTENING    12345
      if (parts.length < 5) continue
      const local = parts[1]
      const colon = local.lastIndexOf(':')
      if (colon === -1) continue
      accept(Number(local.slice(colon + 1)), Number(parts[parts.length - 1]))
    }
    return { ports: [...ports.keys()], pids: ports }
  }

  // Linux: /proc needs no process spawn, but names no owner either.
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const text = await readFile(file, 'utf8')
      for (const line of text.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4 || parts[3] !== '0A') continue // 0A = LISTEN
        const port = parseInt(parts[1].split(':')[1], 16)
        accept(port, 0)
      }
    } catch (error) {
      void error
    }
  }

  // macOS/BSD: lsof knows the addresses, so loopback-only is decidable, and it
  // is also the only source of the owning PID on either platform.
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  for (const line of lsof.split('\n')) {
    if (!/LISTEN/.test(line)) continue
    const match = line.match(/(?:127\.0\.0\.1|\*|\[::1\]|localhost):(\d+)/)
    if (!match) continue
    accept(Number(match[1]), Number(line.trim().split(/\s+/)[1]))
  }

  // Anything else: netstat is ubiquitous.
  if (ports.size === 0) {
    const netstat = await run('netstat', ['-an'])
    for (const line of netstat.split('\n')) {
      if (!/LISTEN/.test(line)) continue
      const match = line.match(/[.:](\d+)\s/)
      if (match) accept(Number(match[1]), 0)
    }
  }

  return { ports: [...ports.keys()], pids: ports }
}

function titleOf(html) {
  const match = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)
  return match ? match[1].replace(/\s+/g, ' ').trim() : ''
}

async function probePort(value, timeoutMs) {
  for (const hostname of ['127.0.0.1', '[::1]']) {
    try {
      const res = await fetch(`http://${hostname}:${value}/`, {
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
      const type = String(res.headers.get('content-type') || '')
      if (res.status >= 400 || (type && !type.includes('html'))) { await res.body?.cancel(); continue }
      const html = type.includes('html') ? (await res.text()).slice(0, 120_000) : ''
      if (!type) await res.body?.cancel()
      return { port: value, url: `http://${hostname}:${value}/`, href: res.url,
        title: titleOf(html) || `${hostname}:${value}`, status: res.status }
    } catch { /* Try IPv6 when a dev server listens only on ::1. */ }
  }
  return null
}

/** What each listening process is running. Windows has no /proc and no portable
 *  cwd, so the executable path and the command line are the evidence available;
 *  Linux answers from /proc, macOS/BSD from ps.
 *
 *  Two Windows strategies, because a packaged Electron host is not a normal
 *  shell: its PATH may not carry WindowsPowerShell, and its console code page
 *  may not be UTF-8. The absolute PowerShell path fixes the first, an explicit
 *  UTF-8 output encoding fixes the second, and `wmic` covers a host where
 *  PowerShell itself is blocked. */
async function processTable(pids) {
  const table = new Map()
  const add = (pid, exe, cmd) => {
    const id = Number(pid)
    if (!Number.isInteger(id) || id <= 0) return
    table.set(id, { exe: String(exe || ''), cmd: String(cmd || '') })
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const absolute = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const query = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
    const json = await run(existsSync(absolute) ? absolute : 'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', query], 15000)
    try {
      const raw = JSON.parse(json.replace(/^\uFEFF/, ''))
      for (const row of Array.isArray(raw) ? raw : [raw]) {
        add(row && row.ProcessId, row && row.ExecutablePath, row && row.CommandLine)
      }
    } catch (error) {
      void error
    }
    if (table.size) return table

    // `wmic process get ProcessId,CommandLine /format:csv` emits
    // `Node,CommandLine,ProcessId` rows; the pid is last, so a command line with
    // commas cannot be mistaken for the column order.
    const csv = await run('wmic', ['process', 'get', 'ProcessId,CommandLine', '/format:csv'], 15000)
    for (const line of csv.split(/\r?\n/)) {
      const match = line.trim().match(/^([^,]*),(.*),(\d+)$/)
      if (match) add(match[3], '', match[2])
    }
    return table
  }
  for (const pid of pids) {
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim()
      let exe = ''
      try { exe = await realpath(`/proc/${pid}/exe`) } catch (error) { void error }
      add(pid, exe, cmd)
    } catch (error) {
      void error
    }
  }
  if (table.size === 0 && pids.length) {
    const text = await run('ps', ['-o', 'pid=,comm=,args=', '-p', pids.join(',')])
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
      if (match) add(match[1], match[2], match[3])
    }
  }
  return table
}

/** One spelling for comparisons: forward slashes folded, trailing separator
 *  dropped, case-insensitive (Windows paths are). */
const normalizePath = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Why this process may serve `root`, or false when nothing ties it there. */
function claimOf(entry, root) {
  const base = normalizePath(root)
  if (!base || !entry) return false
  const exe = normalizePath(entry.exe)
  if (exe && (exe === base || exe.startsWith(base + '\\'))) return 'exe'
  const cmd = String(entry.cmd || '')
  if (!cmd) return false
  if (normalizePath(cmd).includes(base + '\\')) return 'commandLine'
  // A dev server is often started as `node scripts/dev-server.mjs` from the
  // workspace, which names no directory at all. A relative script path that
  // exists inside the workspace is the next best evidence.
  const tokens = cmd.match(/[A-Za-z0-9_.\\/:-]+\.(?:mjs|cjs|jsx?|tsx?|mts|cts|py|sh|ps1|cmd|bat)\b/g) || []
  for (const token of tokens.slice(0, 8)) {
    if (!/[\\/]/.test(token)) continue
    let candidate
    try {
      candidate = resolve(root, token)
    } catch (error) {
      continue
    }
    if (!insideRoot(candidate, root)) continue
    if (existsSync(candidate)) return 'script:' + token
  }
  return false
}

/** Ports the workspace asks for itself —`--port 4173` in a package script,
 *  `PORT || 4173` in a dev server, `port:` in a Vite config. Evidence, not a
 *  guess: the port still has to be listening to appear. */
async function declaredProjectPorts(root) {
  const declared = new Map() // port -> source file
  if (!root) return declared
  const sources = []
  const read = async (file) => {
    try {
      sources.push({ file: basename(file), text: await readFile(file, 'utf8') })
    } catch (error) {
      void error
    }
  }
  await read(join(root, 'package.json'))
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cjs',
    'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'astro.config.mjs', 'svelte.config.js', 'webpack.config.js',
    'start-local.cmd', 'start.cmd', 'start.sh', 'serve.cmd', 'dev.cmd', 'dev.sh']) {
    await read(join(root, name))
  }
  try {
    for (const entry of await readdir(join(root, 'scripts'), { withFileTypes: true })) {
      if (!entry.isFile() || !/^(dev|serve|start|server|preview)/i.test(entry.name)) continue
      if (!/\.(mjs|cjs|js|ts|sh|ps1|cmd|bat)$/i.test(entry.name)) continue
      await read(join(root, 'scripts', entry.name))
    }
  } catch (error) {
    void error
  }
  for (const { file, text } of sources) {
    const add = (value) => {
      const port = Number(value)
      if (Number.isInteger(port) && port >= 1024 && port <= 65535 && !declared.has(port)) declared.set(port, file)
    }
    for (const [, value] of text.matchAll(/--port[=\s]+['"]?(\d{2,5})/g)) add(value)
    for (const [, value] of text.matchAll(/\bPORT\b[^0-9\n]{0,16}(\d{2,5})/g)) add(value)
    for (const [, value] of text.matchAll(/\bport\s*[:=]\s*['"]?(\d{2,5})/g)) add(value)
    for (const [, value] of text.matchAll(/listen\(\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d{2,5})/g)) add(value)
  }
  return declared
}

/** HTML pages the workspace already contains, so a project that needs no server
 *  —or whose server is not running —can still be annotated. */
async function staticCandidates(root) {
  const pages = []
  if (!root) return pages
  const seen = new Set()
  for (const dir of STATIC_DIRS) {
    const base = dir ? join(root, dir) : root
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    const names = entries.filter((entry) => entry.isFile() && isHtmlFile(entry.name)).map((entry) => entry.name)
    names.sort((a, b) => (a.toLowerCase() === 'index.html' ? 0 : 1) - (b.toLowerCase() === 'index.html' ? 0 : 1) || a.localeCompare(b))
    for (const name of names) {
      if (pages.length >= STATIC_PAGE_LIMIT) return pages
      let real
      try {
        real = await realpath(join(base, name))
      } catch (error) {
        void error
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      pages.push({ rel: dir ? `${dir}/${name}` : name, path: real })
    }
  }
  return pages
}

/** The file a static request resolves to: inside the root, a regular file, and
 *  never a directory. Symlinks are resolved before the containment test. */
async function existingFile(file, root) {
  let real
  try {
    real = await realpath(file)
  } catch (error) {
    void error
    return null
  }
  if (!insideRoot(real, root)) return null
  try {
    const info = await stat(real)
    if (!info.isFile()) return null
    return { path: real, size: info.size }
  } catch (error) {
    void error
    return null
  }
}

/** Read-only file server for one directory: the loopback origin a static page
 *  needs before the preview proxy can read and inject into it. */
async function serveStatic(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
  } catch (error) {
    void error
    res.writeHead(400)
    res.end()
    return
  }
  if (hasHiddenSegment(pathname)) {
    res.writeHead(403)
    res.end()
    return
  }
  const requested = resolve(root, '.' + (pathname.charAt(0) === '/' ? pathname : '/' + pathname))
  if (!insideRoot(requested, root)) {
    res.writeHead(403)
    res.end()
    return
  }
  // The file itself, then a directory's index, then —for a client-side route
  // with no extension —the root page, which is what keeps an SPA navigable.
  let target = await existingFile(requested, root)
  if (!target) target = await existingFile(join(requested, 'index.html'), root)
  if (!target && !extname(pathname) && String(req.headers.accept || '').includes('html')) {
    target = await existingFile(join(root, 'index.html'), root)
  }
  if (!target) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (target.size > STATIC_FILE_LIMIT) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('file too large for a preview')
    return
  }
  res.writeHead(200, {
    'content-type': staticMime(target.path),
    'content-length': String(target.size),
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(await readFile(target.path))
}

/** A `file://` target is previewable only when it is an HTML file inside the
 *  session workspace: nothing outside it may be read, and only a page can be
 *  annotated. */
function resolveFileTarget(raw, root) {
  let url
  try {
    url = new URL(String(raw))
  } catch (error) {
    void error
    return { code: 'notLocalTarget' }
  }
  if (url.protocol !== 'file:' || url.host) return { code: 'notLocalTarget' }
  let pathname = decodeURIComponent(url.pathname)
  // A file URL for a Windows drive is `/D:/dir/page.html`, but Node resolves a
  // leading slash against the current drive's root and looks for `D:\D:`.
  // Strip that slash so the drive letter is the path's own first segment.
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
  let path
  try {
    path = realpathSync(pathname)
  } catch (error) {
    void error
    return { code: 'staticUnavailable' }
  }
  if (!insideRoot(path, root)) return { code: 'notAllowedFile' }
  let info
  try {
    info = statSync(path)
  } catch (error) {
    void error
    return { code: 'staticUnavailable' }
  }
  if (!info.isFile()) return { code: 'staticUnavailable' }
  if (!isHtmlFile(path)) return { code: 'notHtmlFile' }
  return { dir: dirname(path), name: basename(path) }
}

/** How to start something, read from the session workspace. */
async function startupHint(root) {
  if (!root) return null
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? Object.keys(pkg.scripts) : []
    const wanted = ['dev', 'start', 'dev:panel', 'serve', 'preview']
    const picked = wanted.filter((name) => scripts.includes(name))
    if (picked.length === 0) return { runner: null, commands: [] }
    let runner = 'npm'
    let build = (name) => (name === 'start' ? 'npm start' : `npm run ${name}`)
    for (const [file, name, make] of [
      ['pnpm-lock.yaml', 'pnpm', (s) => (s === 'dev' ? 'pnpm dev' : s === 'start' ? 'pnpm start' : `pnpm run ${s}`)],
      ['yarn.lock', 'yarn', (s) => `yarn ${s}`],
      ['bun.lockb', 'bun', (s) => `bun run ${s}`],
      ['bun.lock', 'bun', (s) => `bun run ${s}`],
    ]) {
      try {
        await readFile(join(root, file))
        runner = name
        build = make
        break
      } catch (error) {
        void error
      }
    }
    return { runner, commands: picked.map((name) => ({ script: name, command: build(name) })) }
  } catch (error) {
    void error
    return null
  }
}

export function apply(ctx, config = {}) {
  // ---- proxy ---------------------------------------------------------------
  const probeTimeoutMs = Number(config.detect?.probeTimeoutMs) || 900
  const detectCacheMs = Number(config.detect?.cacheMs) || 2000
  const extraPorts = Array.isArray(config.detect?.extraPorts) ? config.detect.extraPorts.map(Number) : []
  const staticFiles = config.detect?.staticFiles !== false
  const detections = new Map()
  const previews = new Map()
  const previewActivity = new Map()
  const staticServers = new Map()
  let disposed = false

  const closeUnusedStatic = (dir) => {
    if (!dir || [...previewActivity.values()].some((entry) => entry.dir === dir)) return
    const promise = staticServers.get(dir)
    staticServers.delete(dir)
    if (promise) void promise.then((entry) => entry.close()).catch(() => {})
  }
  const closePreview = (key) => {
    const promise = previews.get(key)
    const activity = previewActivity.get(key)
    previews.delete(key)
    previewActivity.delete(key)
    if (promise) void promise.then((entry) => entry.close()).catch(() => {})
    closeUnusedStatic(activity?.dir)
  }
  const reapPreviews = () => {
    const now = Date.now()
    for (const [key, activity] of previewActivity) {
      for (const [lease, until] of activity.leases) {
        if (until <= now) activity.leases.delete(lease)
      }
      if (!activity.leases.size && now - activity.at >= PREVIEW_IDLE_MS) closePreview(key)
    }
  }
  ctx.effect(() => {
    const timer = setInterval(reapPreviews, 30_000)
    timer.unref?.()
    return () => {
      disposed = true
      clearInterval(timer)
      for (const key of previews.keys()) closePreview(key)
      for (const dir of staticServers.keys()) closeUnusedStatic(dir)
    }
  })

  /** One read-only file server per directory, started the first time a page in
   *  it is previewed. It exists so a static file has a loopback origin for the
   *  proxy to read: an iframe cannot be injected through `file://`. */
  const staticServer = async (dir) => {
    let promise = staticServers.get(dir)
    if (!promise) {
      promise = (async () => {
        const server = http.createServer((req, res) => {
          // Only the exact address this server bound may read it, so a
          // DNS-rebinding page cannot reach the workspace through this origin.
          if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return }
          void serveStatic(req, res, dir).catch((error) => {
            void error
            try { res.destroy() } catch (inner) { void inner }
          })
        })
        const sockets = new Set()
        server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
        const entry = { origin: `http://127.0.0.1:${server.address().port}`, close() { for (const socket of sockets) socket.destroy(); server.close() } }
        if (disposed) entry.close()
        return entry
      })()
      staticServers.set(dir, promise)
      promise.catch(() => { if (staticServers.get(dir) === promise) staticServers.delete(dir) })
    }
    return promise
  }

  const detect = async (sid, args, req) => {
    const key = sid || '__root__'
    const cached = detections.get(key)
    if (!args?.force && cached && Date.now() - cached.at < detectCacheMs) return cached.value

    const root = existingDirectory(args && args.root)
    const selfPort = hostPort(req.headers.host)
    const previewPorts = new Set((await Promise.all([...previews.values()])).map((entry) => Number(new URL(entry.origin).port)))
    for (const entry of await Promise.all(staticServers.values())) previewPorts.add(Number(new URL(entry.origin).port))
    const { ports: found, pids } = await listeningPorts()
    const declared = await declaredProjectPorts(root)
    const table = root && pids.size ? await processTable([...new Set(pids.values())]) : new Map()

    // A service is listed only when it is claimed: its process names the
    // workspace (executable, command line, or a script inside it), or the
    // workspace declares the port it listens on. Unclaimed listeners are the
    // noise this plugin exists to keep out of the list.
    const claimed = new Map() // port -> reason
    if (root) {
      for (const [port, pid] of pids) {
        const reason = claimOf(table.get(pid), root)
        if (reason) claimed.set(port, reason)
      }
      for (const [port, file] of declared) {
        if (found.includes(port) && !claimed.has(port)) claimed.set(port, 'declared:' + file)
      }
      for (const port of extraPorts) {
        if (Number.isInteger(port) && port > 0 && !claimed.has(port)) claimed.set(port, 'configured')
      }
    }
    const candidates = [...claimed.keys()]
      .filter((value) => Number.isInteger(value) && value > 0 && value < 65536 && value !== selfPort && !previewPorts.has(value))
      .sort((a, b) => a - b)

    const probed = []
    for (let i = 0; i < candidates.length; i += 16) {
      probed.push(...await Promise.all(candidates.slice(i, i + 16).map((value) => probePort(value, probeTimeoutMs))))
    }
    const services = probed.filter(Boolean)
      .map((service) => ({ ...service, reason: claimed.get(service.port) || '' }))
      .sort((a, b) => a.port - b.port)
    const value = {
      ok: true,
      rootKnown: Boolean(root),
      root: root || null,
      services,
      files: staticFiles ? await staticCandidates(root) : [],
      hint: await startupHint(root),
      scanned: candidates.length,
      listening: found.length,
      // One line of provenance for troubleshooting a host where the process
      // table could not be read: claims need it, so `processes: 0` explains an
      // empty list that is not the workspace's fault.
      diag: { listening: found.length, processes: table.size, claimed: claimed.size, declared: declared.size },
      at: Date.now(),
    }
    detections.set(key, { at: Date.now(), value })
    return value
  }

  const handler = async (req, res) => {
    if (req.headers.origin && req.headers.origin !== requestOrigin(req)) { send(res, 403, { ok: false, code: 'originNotAllowed', error: 'origin not allowed' }); return }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, code: 'methodNotAllowed', error: 'method not allowed' })
      return
    }
    try {
      const body = await readJson(req)
      const method = body && body.method
      const args = (body && body.args) || {}
      const sid = args.sid
      if (disposed) return send(res, 503, { ok: false, error: 'plugin is shutting down' })
      if (method === 'state') {
        return send(res, 200, {
          ok: true,
          version: 'dsh-lens',
          root: existingDirectory(args.root),
          previews: previews.size,
        })
      }
      if (method === 'preview') {
        reapPreviews()
        const raw = String(args.url || '')
        let target
        let suffix
        let dir = null
        let fileRoot = null
        if (/^file:/i.test(raw)) {
          const resolved = resolveFileTarget(raw, existingDirectory(args.root))
          if (resolved.code) return send(res, 400, { ok: false, code: resolved.code, error: 'that file cannot be previewed' })
          const server = await staticServer(resolved.dir)
          dir = resolved.dir
          // The page's own directory is the static root, so its relative scripts
          // and styles resolve exactly as they do on disk.
          target = new URL(server.origin + '/')
          const fileUrl = new URL(raw)
          fileRoot = new URL('.', fileUrl).href
          suffix = '/' + encodeURIComponent(resolved.name) + fileUrl.search + fileUrl.hash
        } else {
          try { target = new URL(raw) } catch (error) { void error; target = null }
          if (!target || !isLocalTarget(target) || Number(target.port) === hostPort(req.headers.host)) return send(res, 400, { ok: false, code: 'notLocalTarget', error: 'local development services only; Harness itself cannot be previewed' })
          suffix = target.pathname + target.search + target.hash
        }
        // Desktop forwards API requests to its HTTP backend, while the actual
        // frame parent remains the privileged dsh-app document.
        const parentOrigin = args.parentOrigin === 'dsh-app://app' ? args.parentOrigin : requestOrigin(req)
        const key = String(sid) + ':' + parentOrigin + ':' + target.origin + ':' + (fileRoot || '')
        if (!previews.has(key)) {
          if (previews.size >= 24) {
            closeUnusedStatic(dir)
            return send(res, 429, { ok: false, code: 'tooManyPreviews', error: 'too many active previews; close another preview and retry' })
          }
          const activity = { at: Date.now(), leases: new Map(), dir, sid }
          previewActivity.set(key, activity)
          const promise = createPreview(target, String(sid || ''), parentOrigin, fileRoot, () => { activity.at = Date.now() }, Boolean(config.debug))
          previews.set(key, promise)
          promise.catch(() => { if (previews.get(key) === promise) closePreview(key) })
        }
        const activity = previewActivity.get(key)
        activity.at = Date.now()
        if (typeof args.lease === 'string' && args.lease) activity.leases.set(args.lease, Date.now() + PREVIEW_IDLE_MS)
        const entry = await previews.get(key)
        if (disposed) { entry.close(); return send(res, 503, { ok: false, error: 'plugin is shutting down' }) }
        const frameUrl = new URL(entry.origin + suffix)
        if (entry.frameKey) addFrameKey(frameUrl, entry.frameKey)
        return send(res, 200, { ok: true, url: frameUrl.href, origin: entry.origin })
      }
      if (method === 'retainPreview' || method === 'releasePreview') {
        for (const [key, promise] of previews) {
          const activity = previewActivity.get(key)
          if (activity?.sid !== sid || !activity.leases.has(args.lease)) continue
          const preview = await promise
          if (previews.get(key) !== promise || !activity.leases.has(args.lease)) continue
          if (preview.origin !== args.origin) continue
          if (method === 'releasePreview') {
            activity.leases.delete(args.lease)
            if (!activity.leases.size) closePreview(key)
          } else {
            activity.at = Date.now()
            activity.leases.set(args.lease, Date.now() + PREVIEW_IDLE_MS)
          }
          return send(res, 200, { ok: true })
        }
        return send(res, 200, { ok: method === 'releasePreview' })
      }
      if (method === 'detect') return send(res, 200, await detect(sid, args, req))
      return send(res, 200, { ok: false, error: 'unknown method: ' + String(method) })
    } catch (error) {
      return send(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
  if (existsSync(join(tmpdir(), 'dsh-lens-auth-bridge'))) installAuthBridge(ctx)
  ctx.logger?.('dsh-lens')?.info?.(
    `dsh-lens: workspace-scoped loopback previews on demand, ws relay at ${WS_RELAY_PATH}, api ${ROUTE}`
  )
}

/** Verification-only helper, off unless `config.authBridge` is true.
 *
 *  The Harness web carrier authenticates the browser with a signed cookie whose
 *  key lives in the profile credential store. An external Chromium has no such
 *  cookie, so this route mints one for the request's own authority and redirects
 *  to the GUI — which is how the plugin's own screenshots are taken. It is
 *  deliberately config-gated and never enabled in a shipped install. */
function installAuthBridge(ctx) {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const credentials = join(home, '.credentials.yaml')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/__lens-auth-bridge',
    handler: (req, res) => {
      try {
        // Re-checked per request: deleting the marker file disables the bridge
        // immediately, without waiting for another restart.
        if (!existsSync(join(tmpdir(), 'dsh-lens-auth-bridge'))) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        const text = readFileSync(credentials, 'utf8')
        let secret = ''
        let inRecord = false
        for (const line of text.split(/\r?\n/)) {
          if (/client-connection\/browser-session:/.test(line)) { inRecord = true; continue }
          if (!inRecord) continue
          const match = line.match(/^\s+secret:\s*(\S+)\s*$/)
          if (match) { secret = match[1]; break }
        }
        if (!secret) throw new Error('browser-session secret not found')
        const authority = String(req.headers.host || '')
        const now = Date.now()
        const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 7 * 86_400_000 }
        const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
        const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest().toString('base64url')
        const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'set-cookie': `${name}=v1.${body}.${signature}; Path=/; HttpOnly; SameSite=Strict`,
        })
        res.end()
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-lens auth bridge: ' + String((error && error.message) || error))
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

const cookiePrefix = (enc) => `anno_${enc}_`

/** Cookies the browser holds for the harness must never reach the proxied app,
 *  and the app's own cookies must not escape into the harness. */
function splitCookies(header, enc) {
  const prefix = cookiePrefix(enc)
  const forwarded = []
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    const name = eq === -1 ? '' : trimmed.slice(0, eq)
    if (!name || !name.startsWith(prefix)) continue
    forwarded.push(`${name.slice(prefix.length)}=${trimmed.slice(eq + 1)}`)
  }
  return forwarded.join('; ')
}

/** Namespace the app's cookies and re-scope them to the preview origin.
 *  The preview is plain http on loopback, so `SameSite=None` requires `Secure`
 *  and, in Chromium, partitioned storage. */
function rewriteSetCookie(value, enc, target) {
  const prefix = cookiePrefix(enc)
  const parts = String(value).split(';').map((part) => part.trim())
  const first = parts[0]
  const eq = first.indexOf('=')
  const name = eq === -1 ? first : first.slice(0, eq)
  const payload = eq === -1 ? '' : first.slice(eq + 1)
  const out = [`${prefix}${name}=${payload}`]
  let cookiePath = '/'
  for (const attribute of parts.slice(1)) {
    const lower = attribute.toLowerCase()
    if (lower.startsWith('domain=')) continue
    if (lower.startsWith('path=')) { cookiePath = attribute.slice(5).startsWith('/') ? attribute.slice(5) : '/'; continue }
    if (lower.startsWith('samesite=') || lower === 'secure' || lower === 'partitioned') continue
    out.push(attribute)
  }
  out.push(`Path=${cookiePath}`)
  out.push('SameSite=None', 'Secure', 'Partitioned')
  return out.join('; ')
}

/**
 * The preview server serves the app at its own paths, so no document URL needs
 * rewriting and no import map is needed. Injecting a second import map would in
 * fact be harmful: a document may only have one, and ours would win over the
 * app's. Only the annotation config, the shim and the overlay are added.
 */
function injectIntoHtml(html, config) {
  // Inline scripts inherit the document's encoding. Keep our source ASCII so
  // localized labels and config survive pages without a charset declaration
  // (or with a legacy charset), without changing the application's encoding.
  const script = (source) => source.replace(/[^\x00-\x7f]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
  const head =
    `<script>window.__DSH_LENS__=${script(JSON.stringify(config).replace(/</g, '\\u003c'))};</script>` +
    `<script>${script(readInjected('./shim.js'))}</script>` +
    (config.isolated ? `<script>${script(readInjected('./overlay.js'))}</script>` : '')
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => match + head)
    : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (match) => match + head)
      : head + html
}

function proxyHttp(req, res, preview) {
  const incoming = new URL(req.url, 'http://localhost')
  const { target, enc, tail, search } = {
    target: preview.target,
    enc: encodeTarget(preview.target.origin),
    tail: incoming.pathname,
    search: incoming.search,
  }
  const origin = target.origin

  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue
    if (lower === 'accept-encoding') continue // keep bodies readable for rewriting
    // A development preview must show edits even when its server advertises
    // immutable assets or answers a stale validator with 304.
    if ((req.method === 'GET' || req.method === 'HEAD') && (lower === 'if-none-match' || lower === 'if-modified-since')) continue
    if (lower === 'cookie') {
      const forwarded = splitCookies(value, enc)
      if (forwarded) headers.cookie = forwarded
      continue
    }
    if (lower === 'origin') {
      headers.origin = origin
      continue
    }
    if (lower === 'referer') {
      // The preview keeps the app's own paths, so only the origin changes.
      try {
        const ref = new URL(value)
        if (preview.frameKey) clearFrameKey(ref)
        headers.referer = origin + ref.pathname + ref.search
      } catch (error) { void error }
      continue
    }
    headers[key] = value
  }
  headers.host = target.host
  headers['accept-encoding'] = 'identity'
  headers['cache-control'] = 'no-cache'

  const upstream = (target.protocol === 'https:' ? https : http).request(
    {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: tail + search,
      headers,
    },
    (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] || '')
      const out = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (UNFRAMEABLE.has(lower)) continue
        if (lower === 'content-length' || lower === 'content-encoding') continue
        if (lower === 'set-cookie') {
          out['set-cookie'] = (Array.isArray(value) ? value : [value]).map((one) => rewriteSetCookie(one, enc, target))
          continue
        }
        if (lower === 'location' && typeof value === 'string') {
          // An absolute upstream redirect must stay on the preview origin or
          // the next document will lose the shim and annotation overlay.
          try {
            const destination = new URL(value, origin + tail + search)
            if (destination.origin === origin) {
              // The initial custom-scheme iframe has no Referer on a redirect
              // either. Keep its capability on local redirects only.
              if (preview.frameKey && req.headers['sec-fetch-dest'] === 'iframe') addFrameKey(destination, preview.frameKey)
              out.location = destination.pathname + destination.search + destination.hash
            } else out.location = value
          } catch { out.location = value }
          continue
        }
        out[key] = value
      }
      out['cache-control'] = 'no-store'
      delete out.expires

      if (!type.includes('text/html')) {
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
        return
      }

      // HTML: inject config, shim and overlay before any app script runs.
      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
        const body = Buffer.from(
          injectIntoHtml(html, { upstream: origin, page: preview.fileRoot ? new URL('.' + tail + search, preview.fileRoot).href : null, fileRoot: preview.fileRoot, prefix: '/', relay: WS_RELAY_PATH, enc, isolated: true, parentOrigin: preview.parentOrigin, session: preview.sid, debug: Boolean(preview.debug) }),
          'utf8'
        )
        out['content-length'] = String(body.length)
        res.writeHead(upstreamRes.statusCode ?? 200, out)
        res.end(body)
      })
      upstreamRes.on('error', () => res.end())
    }
  )

  upstream.setTimeout(15000, () => upstream.destroy(new Error('connection timed out')))
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<body style="font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:20px;color:#666">${escapeHtml(error.message)}` +
      `<script>parent.postMessage({source:'dsh-lens-page',type:'error',code:'upstreamUnreachable'},${JSON.stringify(preview.parentOrigin)})</script></body>`
    )
  })
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const enc = url.searchParams.get('to') || ''
  const targetPath = url.searchParams.get('path') || '/'
  let target
  try {
    target = new URL(decodeTarget(enc))
    if (!isLocalTarget(target)) throw new Error('local targets only')
  } catch (error) {
    void error
    socket.destroy()
    return
  }

  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'authorization' || HOP_BY_HOP.has(lower)) continue
    if (lower === 'cookie') {
      const forwarded = splitCookies(value, enc)
      if (forwarded) headers.cookie = forwarded
      continue
    }
    if (lower === 'origin') {
      headers.origin = target.origin
      continue
    }
    headers[key] = value
  }
  headers.host = target.host
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upstream = (target.protocol === 'https:' ? https : http).request({
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ''),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: targetPath.startsWith('/') ? targetPath : new URL(targetPath).pathname + new URL(targetPath).search,
    headers,
  })
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      if (Array.isArray(value)) for (const one of value) lines.push(`${key}: ${one}`)
      else lines.push(`${key}: ${value}`)
    }
    lines.push('connection: Upgrade')
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
    if (head && head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const close = () => {
      upstreamSocket.destroy()
      socket.destroy()
    }
    upstreamSocket.on('error', close)
    upstreamSocket.on('close', close)
    socket.on('error', close)
    socket.on('close', close)
  })
  upstream.on('response', (upstreamRes) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 400} ${upstreamRes.statusMessage ?? 'Bad Request'}`]
    for (const [key, value] of Object.entries(upstreamRes.headers)) lines.push(`${key}: ${value}`)
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    socket.destroy()
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

/** A dedicated loopback origin preserves app paths and separates app DOM and
 * storage from Harness. Nothing outside loopback may be used as an upstream.
 * Servers are keyed by session + app and disposed with the plugin. */
async function createPreview(target, sid, parentOrigin, fileRoot, touch, debug) {
  const hostname = new URL(parentOrigin).hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  // A directory can contain several pages; derive each document's identity
  // from its own path instead of caching the first file opened in this session.
  const frameKey = parentOrigin === 'dsh-app://app' ? randomUUID() : null
  const preview = { target: new URL(target.origin), sid, parentOrigin, fileRoot, frameKey, debug }
  const originOfPreview = () => `http://${hostname}:${server.address().port}`
  const server = http.createServer((req, res) => {
    // Only the preview's own hostname is served, so a DNS-rebinding page cannot
    // reach the app through this origin.
    if (req.headers.host !== `${hostname}:${server.address().port}`) { res.writeHead(403); res.end(); return }
    const frameUrl = new URL(req.url, originOfPreview())
    // Chromium omits the custom-scheme Referer on a desktop iframe load.
    // Authorize that initial navigation with an unguessable per-preview key,
    // retaining provenance checks for unrelated pages and subresource fetches.
    const keyedFrame = frameKey && req.headers['sec-fetch-dest'] === 'iframe' && frameUrl.searchParams.get('__dsh_lens_key') === frameKey
    if (!keyedFrame && !allowedPreviewRequest(req, parentOrigin, originOfPreview())) { res.writeHead(403); res.end(); return }
    if (frameKey) clearFrameKey(frameUrl)
    req.url = frameUrl.pathname + frameUrl.search
    touch()
    proxyHttp(req, res, preview)
  })
  const sockets = new Set()
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin !== originOfPreview()) { socket.destroy(); return }
    touch()
    const path = req.url
    req.url = WS_RELAY_PATH + '?to=' + encodeTarget(target.origin) + '&path=' + encodeURIComponent(path)
    proxyUpgrade(req, socket, head)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, hostname, resolve) })
  return { server, frameKey, origin: `http://${hostname}:${server.address().port}`, close() { for (const socket of sockets) socket.destroy(); server.close() } }
}
