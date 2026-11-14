/**
 * 兼容 shim：实现已下沉到 src/shared/stream-fold.ts（distill 与 wiki 共用同一份，
 * 避免 wiki 反向 import distill 形成目录级环 / AD-33）。
 *
 * 保留本文件是为了不破坏既有 import 路径（distill/* 内部与 test/distill-stream-fold.test.ts）。
 */
export * from '../shared/stream-fold.js'
