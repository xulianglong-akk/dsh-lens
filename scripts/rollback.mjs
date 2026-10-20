/**
 * One-command rollback for dsh-lens.
 *
 *   node scripts/rollback.mjs [--profile <dir>]
 *
 * Restores the newest profile package.json backup (dependency row and bundle
 * row gone in the same step), removes the linked package from the profile's
 * node_modules and tells you to restart. Nothing else in the profile is touched.
 */
import { existsSync, readdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const profileArg = args.indexOf('--profile')
const profileDir = profileArg !== -1
  ? resolve(args[profileArg + 1])
  : join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'profiles', 'desktop')

const packageFile = join(profileDir, 'package.json')
const backupDir = join(profileDir, '_rollback')
if (!existsSync(backupDir)) {
  console.error('no backups at', backupDir)
  process.exit(1)
}
const backups = readdirSync(backupDir)
  .filter((name) => /^package\.json\..*\.bak$/.test(name))
  .sort()
if (!backups.length) {
  console.error('no package.json backups found in', backupDir)
  process.exit(1)
}

const newest = join(backupDir, backups[backups.length - 1])
const restored = JSON.parse(readFileSync(newest, 'utf8'))
copyFileSync(newest, packageFile)
console.log('restored', packageFile, 'from', newest)
console.log('bundles now ->', (restored.dsh && restored.dsh.profile && restored.dsh.profile.bundles || []).join(', '))

const linked = join(profileDir, 'node_modules', 'dsh-lens')
if (existsSync(linked)) {
  rmSync(linked, { recursive: true, force: true })
  console.log('removed', linked)
}
console.log('\nNow fully quit and reopen DSH (a page refresh is not enough for the host half).')
