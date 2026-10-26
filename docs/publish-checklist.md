# 发布清单

按顺序做，每一步都能单独验证。

## 1. 推到 GitHub

```bash
git clone https://github.com/charovo0059/dsh-model-vision.git
cd dsh-model-vision
git config user.name  "charovo0059"
git config user.email "charovo0059@users.noreply.github.com"
```

首次从零建仓库（已完成，留作记录）：

```bash
git init -b main
git add -A
git commit -m "feat: 补上 DSH 漏记的视觉能力，并在模型名后标出「可看图」"
git remote add origin https://github.com/charovo0059/dsh-model-vision.git
git push -u origin main
```

推完去仓库页面确认三件事：

- [ ] 仓库里能看到 `cordis.patch.yml` 和 `lib/`（市场 CI 会去读 `package.json` 的 `dsh.bundle`，没有就直接拒）
- [ ] 仓库 **About** 里加上 topic `dsh-plugin`
- [ ] 仓库描述写成一句实话，例如「补上 DSH 获取模型时漏记的视觉能力」

## 2. 确认能装

在一个干净的 profile 里试一次，确认别人也能装：

```bash
dsh plugin --profile test add github:<你的用户名>/dsh-model-vision
```

## 3. 提市场条目

1. fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 把 `docs/market-entry.yml` 复制成 `data/plugins/charovo0059__dsh-model-vision.yml`（**恰好一层深**，`readEntries()` 只 glob `data/plugins/*.yml` 不递归）
3. 条目里的 `url` / `name` / `icon` 已经是真实地址，不需要替换占位符
4. 提 PR，标题写「Add dsh-model-vision」，body 用 `docs/pr-body.md`

CI 会按顺序检查：条目数量（一 PR 最多 3 条）→ `dsh.bundle` → 仓库满 1 天 → `awesome-lint`。
**仓库今天刚建的话，第 3 项会挂**，等一天再提。

## 4. 截图与图标

都已经在仓库里，不用再上传：

| 用途 | 文件 | 谁读它 |
|---|---|---|
| 市场详情页截图 | `docs/screenshot.png`（真截图，1297×768） | 根目录的 `screenshots.json` |
| 市场卡片图标 | `assets/icon-180.png` | 条目里的 `icon:` |
| 本地看的效果图 | `docs/icon.png`（512） | README |

规则（市场强制）：截图 1-8 张、路径不能越出插件目录、只认 GitHub 图床；图标必须是位图，SVG 会被拒。

截图**必须是真的**。`dsh web` 用进程令牌 cookie 鉴权，无头浏览器拿不到带令牌的地址（`http://127.0.0.1:3080/` 直接回 401），所以只能人工在界面上截：设置 → 模型 → 列表最下面那一行按钮。改文案后重新截一张替换 `docs/screenshot.png` 即可，不需要生成脚本。

## 5. npm（可选，但已准备好）

不上 npm 也能进市场（条目里可以用 GitHub Release 的 `tarball:`）。要发的话，包这边已经改好了：

- `private` 已删（不删 npm 直接拒发）
- `publishConfig.registry` 锁死官方源 —— **本机 `~/.npmrc` 指向 npmmirror 只读镜像，不锁的话 `npm publish` 会 403**
- `files` 收窄到 20 个文件 / 66 kB（排除了 `docs/` 里的截图，README 的图走 GitHub 绝对地址；但保留 `assets/icon-180.png`，DSH 从 `package.json` 的 `icon` 字段读它，缺了插件列表就没图标）
- `prepublishOnly` 已挂上 68 个测试，测试挂了发不出去

```bash
npm view dsh-model-vision version                       # 期望 404（名字是你的）
npm login --registry=https://registry.npmjs.org         # 登录也要指官方源
npm publish --dry-run                                   # 先演练，看三行：源/文件数/体积
npm publish                                             # 需要 2FA 六位数
npm view dsh-model-vision version                       # 验证
```

之后市场条目会自动带上版本号和下载量。详细的报错对照表和录视频用的分镜脚本见 `docs/npm-publish-video-script.md`。

---

## 附：PR 描述

不要从别处复制，直接用 `docs/pr-body.md` 的内容 —— 这里是唯一一份，免得两处说法走散。
