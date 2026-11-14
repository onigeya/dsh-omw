/**
 * `session/event` 宿主事件面（Story 2.2 / AD-6、Story 2.1）。
 *
 * `turn/start` / `turn/end` / `step/end` / `compaction/start` 是宿主全局广播的会话事件
 * （`docs/cookbook/extension-cookbook.md:79`）；事件名不在本 Context 的类型化事件表里，故用一条
 * 具名结构类型显式声明这处接线——不把整个 Context 断言成 any，也便于裸 ctx 单测里降级为不监听。
 */
export interface SessionEventHost {
  on?(event: 'session/event', listener: (session: unknown, event: unknown) => void): unknown
}
