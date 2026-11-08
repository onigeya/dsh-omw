import { defineConfig } from 'tsdown'

/**
 * bundle 入口包构建配置。
 *
 * 产出口径对齐宿主 `@deepseek-ai/dsh-plugin-manager` 的 exports 布局：
 * - lib/index.js：ESM（因 package.json `type: module`；`fixedExtension: false`
 *   让 tsdown 在 node 平台仍用 `.js` 而非 `.mjs`）。
 * - lib/types/index.d.ts：tsc `--emitDeclarationOnly --declarationDir lib/types`
 *   单独吐声明（rolldown-plugin-dts 不支持独立 dts outDir，故声明由 tsc 出；
 *   与 package.json `files` 里的 lib 根下 d.ts 通配及 `exports['.'].types` 一致）。
 *
 * `scripts.build` = `tsdown && tsc -p tsconfig.build.json`。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
