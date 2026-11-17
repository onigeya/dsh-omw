import { defineConfig } from 'tsdown'

/**
 * function 插件构建配置。
 *
 * 产出口径：`lib/index.js`（ESM）+ `lib/types/index.d.ts`（tsc 单独吐）。
 * `fixedExtension: false` 让 node 平台仍输出 `.js` 而非 `.mjs`。
 * 与 `package.json#files`（恰含 `lib/index.js` + `lib/types`，PRD §14）一致。
 *
 * `scripts.build` = `tsdown && tsc -p tsconfig.build.json`。
 */
export default defineConfig({
  // 两个入口：function 插件本体（命名导出）+ 压缩 provider 子路径（default export，AC:1707）。
  entry: ['src/index.ts', 'src/compaction.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
