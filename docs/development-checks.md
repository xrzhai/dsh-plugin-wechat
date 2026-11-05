# 开发检查

在源码目录完成 `pnpm install` 后执行：

```sh
pnpm check
pnpm test
pnpm vendor
pnpm i18n
```

`check` 检查语法、打包元数据、`src/` 与 `bin/` 的未使用 import，以及文案基线。import 检查使用 Espree 和 ESLint 的作用域分析器；不会把注释、字符串或被遮蔽的同名变量当成引用。当前只检查 import，不宣称检查所有未使用变量。工具依赖属于 devDependencies，不参与插件运行。

## 文案基线

`bin/i18n-baseline.json` 保存每个文件的 CJK 行数上限。新文件默认上限为零；一处下降不能抵消另一文件新增。行数下降时检查也会提醒同步降低该文件基线，防止将已消除的债务重新引入。不要通过提高基线让检查通过。

这是启发式统计，不是未翻译字符串的精确数量：注释等被排除，已有双语的 `src/i18n.js` 不计入；内联双语 UI 等仍可能计入。与旧版报告的 1395 行不可直接比较。本轮基线为 1345 行。

新增对话文案优先放入 `src/i18n.js`，每个 key 同时提供 zh/en。首批迁移了处理失败和长任务等待提示；后续优先迁移其他错误/拒绝提示，再处理设置页标签，贴纸、诊断等低频文案继续按需整理。

也可以独立检查总量或基线：

```sh
node bin/i18n-report.mjs --fail-over=1345
node bin/i18n-report.mjs --baseline bin/i18n-baseline.json
```

## 安装器与 vendor

`node bin/install.mjs --help` 仅显示帮助；未知参数、缺失值、无效 Profile 名称会在读写 Profile 前报错。`--dry-run` 验证并显示安装或卸载计划，不落盘，不刷新锁文件。

Vendor 校验与有意补丁的记录方式见 [维护记录](progress.md)。安全范围见 [安全边界](security.md)。仓库不再提供指向缺失工具的 bench 命令，也不把历史性能数字视为当前可复现结果。
