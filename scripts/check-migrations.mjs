// AD-34 迁移一致性门禁。bootstrap 期允许无 migrations；有迁移时 SCHEMA_VERSION 必须等于最大迁移号。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const pkg = join(root, 'packages/dsh-oh-my-whale-memory')
const schema = readFileSync(join(pkg, 'src/db/schema.ts'), 'utf8')
const m = /SCHEMA_VERSION\s*=\s*'([^']+)'/.exec(schema)
if (!m) { console.log('check-migrations: FAIL 未找到 SCHEMA_VERSION'); process.exit(1) }
const version = m[1]
if (!/^\d+$/.test(version)) { console.log('check-migrations: FAIL SCHEMA_VERSION 必须是十进制整数字符串，实为 ' + version); process.exit(1) }
const dir = join(pkg, 'src/db/migrations')
if (!existsSync(dir)) {
  if (version === '1') { console.log('check-migrations: PASS（bootstrap：无 migrations，SCHEMA_VERSION=1）'); process.exit(0) }
  console.log('check-migrations: FAIL 无 migrations 但 SCHEMA_VERSION=' + version); process.exit(1)
}
const entries = readdirSync(dir).filter((f) => /\.(ts|js|sql)$/.test(f))
if (!entries.length) { console.log('check-migrations: FAIL migrations 目录为空'); process.exit(1) }
const nums = []
for (const f of entries) {
  const mm = /^(\d{4})-[^/]+\.(ts|js|sql)$/.exec(f)
  if (!mm) { console.log('check-migrations: FAIL 文件名必须 NNNN-*.ts|js|sql：' + f); process.exit(1) }
  nums.push(Number(mm[1]))
}
nums.sort((a, b) => (a > b ? 1 : a === b ? 0 : -1))
for (let i = 1; nums.length > i; i++) if (nums[i] === nums[i - 1]) { console.log('check-migrations: FAIL 迁移号重复 ' + nums[i]); process.exit(1) }
const max = nums[nums.length - 1]
if (String(max) !== version) { console.log('check-migrations: FAIL SCHEMA_VERSION=' + version + ' 但最大迁移号=' + max); process.exit(1) }
console.log('check-migrations: PASS（' + entries.length + ' 个迁移，SCHEMA_VERSION=' + version + '）')
