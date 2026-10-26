# 发布清单

按顺序做，每一步都能单独验证。

## 1. 推到 GitHub

```bash
cd "E:/dsh工作区/dsh-model-vision"
git config user.name  "你的名字"
git config user.email "你的邮箱"
git commit -m "feat: 补上 DSH 漏记的视觉能力，并在模型名后标出「可看图」"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-model-vision.git
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
2. 把 `docs/market-entry.yml` 复制成 `data/plugins/<用户名>__dsh-model-vision.yml`
3. 把文件里的 `OWNER` 全部替换成你的用户名（`url`、`name`、`icon` 三处）
4. 提 PR，标题写「Add dsh-model-vision」

CI 会按顺序检查：条目数量（一 PR 最多 3 条）→ `dsh.bundle` → 仓库满 1 天 → `awesome-lint`。
**仓库今天刚建的话，第 3 项会挂**，等一天再提。

## 4. 截图与图标

都已经在仓库里，不用再上传：

| 用途 | 文件 | 谁读它 |
|---|---|---|
| 市场详情页截图 | `docs/screenshot-button.png`、`docs/screenshot-result.png` | 根目录的 `screenshots.json` |
| 市场卡片图标 | `assets/icon-180.png` | 条目里的 `icon:` |
| 本地看的效果图 | `docs/icon.png`（512） | README |

规则（市场强制）：截图 1-8 张、路径不能越出插件目录、只认 GitHub 图床；图标必须是位图，SVG 会被拒。
文案改了以后重新出图：

```bash
node tools/shots.mjs       # 需要本机有 Edge/Chrome，以及 playwright-core
```

## 5. npm（可选）

不上 npm 也能进市场（条目里可以用 GitHub Release 的 `tarball:`）。要发 npm：

```bash
npm publish --access public
```

需要先 `npm login`，并且把 `package.json` 里的 `repository` / `homepage` 改成你的真实地址。之后市场条目会自动带上版本号和下载量。

---

## 附：PR 描述可以直接粘这段

```
Adds dsh-model-vision — fills in the vision capability that llm-pi-ai's
"fetch models" reader drops.

- Reads whatever modality shape the gateway publishes (input, input_modalities,
  architecture.input_modalities, vision flags).
- For gateways that publish nothing, probes with two solid-colour images and
  only declares a model image-capable when it names both colours correctly; an
  ambiguous answer leaves the model declared as-is.
- Writes back `input` plus a "· 可看图" suffix on the display name, so the
  composer's model picker shows it.
- One button at the bottom of Settings → Models; idempotent, dryRun available.

Category: vision. Repo declares dsh.bundle. Two screenshots via screenshots.json.
```
