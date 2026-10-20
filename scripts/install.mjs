/**
 * Install dsh-lens into the desktop profile and make the change reversible.
 *
 *   node scripts/install.mjs [--profile <dir>] [--link <plugin dir>]
 *
 * A local plugin is a `link:` dependency plus one bundle row, exactly like the
 * profiles already carry for other local plugins. The profile's package.json is
 * copied to _rollback/ first, so `scripts/rollback.mjs` can put it back byte for
 * byte.
 *
 * The plugin directory defaults to this checkout. Pass `--link` when the checkout
 * lives somewhere a lossy path round-trip could damage: some DSH builds rewrite
 * the profile manifest through the console code page, which mangles non-ASCII
 * paths. An ASCII junction (`mklink /J D:\dsh-lens-src "D:\...\dsh-lens"`) plus
 * `--link D:/dsh-lens-src` avoids that entirely.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const linkArg = args.indexOf('--link')
const packageDir = linkArg !== -1 ? resolve(args[linkArg + 1]) : resolve(here, '..')
const profileArg = args.indexOf('--profile')
const profileDir = profileArg !== -1
  ? resolve(args[profileArg + 1])
  : join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'profiles', 'desktop')

const packageFile = join(profileDir, 'package.json')
if (!existsSync(packageFile)) {
  console.error('profile package.json not found:', packageFile)
  process.exit(1)
}

const backupDir = join(profileDir, '_rollback')
mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(backupDir, `package.json.${stamp}.bak`)
copyFileSync(packageFile, backup)
console.log('backup ->', backup)

const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : []

const linkSpec = 'link:' + packageDir.replace(/\\/g, '/')
const previous = pkg.dependencies['dsh-lens']
pkg.dependencies['dsh-lens'] = linkSpec
if (!bundles.includes('dsh-lens')) bundles.push('dsh-lens')
pkg.dsh.profile.bundles = bundles
writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n')

console.log('dependency dsh-lens =', linkSpec, previous ? `(was ${previous})` : '(new)')
console.log('bundles ->', bundles.join(', '))
console.log('\nNext: run pnpm install in', profileDir)

// Report the backups that exist so a rollback has an obvious target.
const backups = readdirSync(backupDir).filter((name) => name.startsWith('package.json.')).sort()
console.log('backups available:', backups.length)
