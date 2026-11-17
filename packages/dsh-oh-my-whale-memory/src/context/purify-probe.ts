/**
 * iot-thinking 互斥探测（Story 8.6 / T7、AC:1898-1901、矩阵行 14）。
 *
 * 本模块只做**只读探测**：`$DSH_HOME/plugin-data/iot-thinking` 在场 ⇒ 本插件的净化仍只做
 * **text 面**（不夺舍、不复用其代码、不碰它的生成链），并在日志里说明「本机未安装/已安装」
 * 的事实与局限。不在场 ⇒ 行为完全相同（净化本来就是自带的确定性规则）。
 *
 * 路径来源（沿用「profile 目录是唯一事实来源」的原则，`db/paths.ts:4-5`）：由宿主注入的
 * `profileContext.dir`（= `<DSH_HOME>/profiles/<name>`）反推 `<DSH_HOME>`。**刻意不读
 * `process.env.DSH_HOME`**：那是宿主进程全局值（可能是另一个安装/另一个 profile 的根），
 * 用它会让「本实例所在的 DSH home」与探测目标不一致，也会让单测依赖运行环境。
 * 形状不符（拿不到 `<DSH_HOME>`）⇒ 不探测（`path: null`，调用方静默）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** iot-thinking 在 `$DSH_HOME/plugin-data/` 下的目录名。 */
export const IOT_THINKING_PLUGIN = 'iot-thinking'
/** 插件数据目录名。 */
export const PLUGIN_DATA_DIR = 'plugin-data'

export interface IotThinkingProbeInput {
  /** 宿主注入的 `profileContext.dir`（`<DSH_HOME>/profiles/<name>`）。 */
  readonly profileDir?: string | null
}

/** 探测目标路径；定位不到 `$DSH_HOME` 时返回 null（不猜）。 */
export function iotThinkingProbePath(input: IotThinkingProbeInput): string | null {
  const home = homeFromProfileDir(input.profileDir)
  return home === null ? null : join(home, PLUGIN_DATA_DIR, IOT_THINKING_PLUGIN)
}

export interface IotThinkingProbeResult {
  /** true = 本机装了 iot-thinking（本插件仍只做 text 面）。 */
  readonly present: boolean
  /** 探测路径；null = 定位不到（未探测）。 */
  readonly path: string | null
}

/**
 * 只读探测。`existsSync` 抛错（权限等）一律按「不在场」处理：探测失败不得影响激活，
 * 也不得把一句可解释的降级变成启动失败。
 */
export function detectIotThinking(input: IotThinkingProbeInput): IotThinkingProbeResult {
  const path = iotThinkingProbePath(input)
  if (path === null) return { present: false, path: null }
  try {
    return { present: existsSync(path), path }
  } catch {
    return { present: false, path }
  }
}

/** 在场时写进日志的说明（逐字可断言；不写「防止模型学会退化」这类因果链，AC:1901）。 */
export const IOT_THINKING_PRESENT_NOTICE =
  '检测到 iot-thinking 插件目录：本插件的净化只做 text 面（互斥检测，非夺舍），' +
  '不复用其代码；其生成时净化效果未经本机验证，本插件自带确定性规则（省 token + 转录干净 + 记忆写入卫生）。'

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** `<DSH_HOME>/profiles/<name>` ⇒ `<DSH_HOME>`；形状不符（缺一级）⇒ null。 */
function homeFromProfileDir(profileDir: string | null | undefined): string | null {
  const dir = nonEmpty(profileDir)
  if (dir === null) return null
  const profilesDir = dirname(dir)
  if (dirname(profilesDir) === profilesDir) return null
  return dirname(profilesDir)
}
