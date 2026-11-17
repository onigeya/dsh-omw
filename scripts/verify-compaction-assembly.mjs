// Story 8.3 装配实测（不需要模型）：pack → 临时 DSH_HOME 建 profile → 按 e2e harness 的做法
// 用 pnpm overrides 指向本地 tarball → dsh plugin add → --dump-config 验证 A1 是否落地。
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const MEMORY_DIR = join(REPO, 'packages/dsh-oh-my-whale-memory')
const BUNDLE_DIR = join(REPO, 'packages/dsh-oh-my-whale')
const PROFILE = 'asm'

const root = mkdtempSync(join(tmpdir(), 'omw-asm-'))
const dshHome = join(root, '.dsh')
const agentsHome = join(root, '.agents')
const packs = join(root, 'packs')
mkdirSync(packs, { recursive: true })

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: agentsHome,
  PATH: 'C:\\Program Files\\Git\\mingw64\\bin;' + (process.env.PATH ?? ''),
}

function run(line, cwd = REPO) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', line], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

console.log('1) pack')
run(`pnpm --dir "${MEMORY_DIR}" pack --ignore-scripts --pack-destination "${packs}"`)
run(`pnpm --dir "${BUNDLE_DIR}" pack --ignore-scripts --pack-destination "${packs}"`)
const memoryTgz = join(packs, 'dsh-oh-my-whale-memory-0.1.0.tgz')
const bundleTgz = join(packs, 'dsh-oh-my-whale-0.1.0.tgz')
if (!existsSync(memoryTgz) || !existsSync(bundleTgz)) throw new Error('pack 未产出预期 tarball')

console.log('2) 建 profile')
run(`dsh --profile ${PROFILE} --from-default-profile web --dump-config`, root)
const profileDir = join(dshHome, 'profiles', PROFILE)

console.log('3) pnpm overrides → 本地 memory tarball')
appendFileSync(
  join(profileDir, 'pnpm-workspace.yaml'),
  `overrides:\n  dsh-oh-my-whale-memory: "file:${memoryTgz.replaceAll('\\', '/')}"\nallowBuilds:\n  "@ladybugdb/core": true\n`,
  'utf8',
)

console.log('4) dsh plugin add')
run(`dsh plugin --profile ${PROFILE} add "${bundleTgz}"`, root)

console.log('5) --dump-config 验证 A1')
const dump = run(`dsh --profile ${PROFILE} --dump-config`, root)
const lines = dump.split('\n')
const idx = lines.findIndex((line) => line.includes('omw-compaction-engine'))
const stockIdx = lines.findIndex((line) => line.trim() === '- id: compaction-basic')
console.log('--- 我们插入的行 ---')
console.log(idx >= 0 ? lines.slice(idx - 1, idx + 4).join('\n') : '【缺失】omw-compaction-engine 未出现')
console.log('--- stock 行 ---')
console.log(stockIdx >= 0 ? lines.slice(stockIdx, stockIdx + 4).join('\n') : '【缺失】compaction-basic 未出现')
writeFileSync(join(root, 'dump.txt'), dump, 'utf8')
console.log('ROOT=' + root)
