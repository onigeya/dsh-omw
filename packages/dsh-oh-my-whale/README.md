# dsh-oh-my-whale

DSH 记忆插件的 **bundle 包**（发布名 `dsh-oh-my-whale`，AD-2）。它自身不含业务逻辑，只做两件事：

1. `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，让 `dsh plugin add` 把它识别为 bundle；
2. `cordis.patch.yml` 用 `insert:` 行把真正的 function 插件 **`dsh-oh-my-whale-memory`** 注册进 profile。

```bash
dsh plugin --profile <name> add dsh-oh-my-whale
```

安装后用 `dsh --profile <name> --dump-config` 确认 patch 层里出现 `dsh-oh-my-whale-memory`。

- 功能、配置项、斜杠命令与工具清单：见仓库根 [README.md](../../README.md)（中文）/ [README.en.md](../../README.en.md)。
- function 插件本体：[`packages/dsh-oh-my-whale-memory`](../dsh-oh-my-whale-memory)。
- License: [MIT](../../LICENSE)。
