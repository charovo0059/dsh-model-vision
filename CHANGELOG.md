# 更新日志

版本号按 [语义化版本](https://semver.org/lang/zh-CN/)：补功能升次版本，只改 bug 升修订号。
`dsh plugin` 装的是 GitHub 上的 `main`，所以每次推上去就等于发新版。

> 这个仓库从 0.5.1 开始公开（更早的版本只在本机存在，没有留档），所以下面从 0.5.1 记起。

## 0.5.2

修一个会让状态记录串台的问题，并顺手把文档和界面上的几处对不上修掉。

- **修**：状态文件与探测缓存原来只有 `$DSH_HOME/model-vision.status.json` 一个，
  所有 profile 共用、写入是读-合并-覆盖。于是启动第二个 `dsh`（比如装插件时试装一个
  干净 profile）会把正在运行的那个 profile 的记录换成自己的 pid 和别人的 patch 路径。
  现在文件名带 profile：`model-vision.web.status.json` / `model-vision.web.probe.json`；
  宿主不提供 `profileContext` 时回落旧文件名，`tools/check.mjs` 两个名字都认。
- **修**：`probeSkipped` / `probeUnknown` 两个计数只在宿主算出来、界面上完全没渲染，
  README 承诺的「超出显示跳过 N 个」其实看不到。现在结果明细里会显示这两行。
- **修**：README 把探测判定写成「两个颜色都答对才算能看图」，与实现不符。实际是
  答对任意一个就算；答成别的颜色判为只能读文字；一个颜色都不提才算没结论。
- **修**：`package.json` 的 `files` 漏了 `assets/`，而 `icon` 指向 `assets/icon-180.png`。
  从 npm 装的话插件列表里会没有图标。现在 `assets/icon-180.png` 进包了。
- **修**：`peerDependencies` 的 `@deepseek-ai/cordis` 从 `"*"` 改成
  `"^4.0.1 || ^4.0.5-alpha.2"` —— `"*"` 不匹配任何 prerelease，而 DSH 生态大量是
  `0.x-rc.N` 这类版本。这条 peer 本身仍是 `optional`，不会被自动安装。
- **文档**：README 拆成三份（README 给使用者、`docs/troubleshooting.md` 给出问题的人、
  `docs/how-it-works.md` 给想深挖的人），补 `README.en.md`，图片改走 GitHub 绝对地址
  （tarball 不含 `docs/`，相对路径在 npm 页面会裂图）。新增 `CHANGELOG.md`、
  `.github/workflows/test.yml`。

## 0.5.1

第一个公开版本。

- 读网关公布的模态字段（`input` / `input_modalities` / `inputModalities` /
  `architecture.input_modalities` / `modalities.input`，以及 `vision` / `supports_vision` /
  `image_input` / `capabilities.vision`），把 `input: [text, image]` 写回 `llm-pi-ai` 的模型条目。
- 在模型名后加「· 可看图」，`badgeSuffix: ''` 可关。
- 主动探测：网关不公布能力时，发 64×64 纯色图问颜色，判定能看图 / 只能读文字 / 没结论；
  结论缓存（能看图 7 天、不能 1 天），单次有上限（`maxProbes`，默认 40）。
- 设置页模型列表底部的一键按钮 + `POST /plugins/model-vision/detect` 接口。
- `mode: sync` 除了补空缺，也按网关纠正已经写错的声明；`dryRun` 只看不写。
- 两条写通道：优先 `ctx.configEditor.edit()`，热重载冲突时回落到按行改 `cordis.patch.yml`。
- `tools/check.mjs` 接线自检、`tools/preview.mjs` 只读预览。
- 状态记录：`message` 一行人话 + 明细字段。
