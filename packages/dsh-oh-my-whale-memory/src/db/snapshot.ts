/**
 * 「当前快照」四条件谓词（FR-15 召回范围判据，单一实现）。
 *
 * Story 3.1 收敛四处口径不一的副本（有的缺 `recorded_at`、有的只看失效两列）：
 * **检索 / 浏览 / 去重 / 关系识别**这类当前快照口径的调用点只允许经本函数拼接，
 * 绝不再手写 `valid_at / recorded_at / invalid_at / expired_at` 的组合
 * （见 spec 的 Always 第 1 条）；仅判墓碑的**有意口径**除外——未嵌入计数
 * （`countUnembeddedMemories` / `listUnembeddedMemories`）与 EVIDENCE 回填游标
 * （`wiki/evidence-backfill.ts`）只按「非墓碑」取行，不是当前快照判据，不套本谓词。
 *
 * 四条件：
 * - `valid_at <= now`：生效时间不晚于当前时刻（NULL 比较不为真 ⇒ 未设置即排除）；
 * - `recorded_at <= now`：记录时间不晚于当前时刻（as-of 读的另一半）；
 * - `invalid_at IS NULL`：未被新版本作废；
 * - `expired_at IS NULL`：未被显式 forget。
 *
 * `alias` 是节点变量名（`m` / `node` / `x`，按各调用点的 Cypher 变量而定）；
 * `nowExpr` 缺省 `$now`（prepare+execute 绑参），需要内联字面量的调用点
 * （eii.ts 的闭包谓词不能带参数，见该文件的模块注释）传 `sqlInstant(now)` 的
 * 结果字面量。
 *
 * 只读：本模块不写库、不触发写路径。
 */

export function currentSnapshotPredicate(alias: string, nowExpr: string = '$now'): string {
  return [
    `${alias}.valid_at <= ${nowExpr}`,
    `${alias}.recorded_at <= ${nowExpr}`,
    `${alias}.invalid_at IS NULL`,
    `${alias}.expired_at IS NULL`,
  ].join(' AND ')
}
