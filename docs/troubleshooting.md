# 出问题怎么查

README 里那张表覆盖了常见情况。这里补上「怎么看到那些字段」。

## 先找到状态文件

```bash
ls ~/.dsh/model-vision*.status.json
```

一个 profile 一份，名字带 profile：

| 文件 | 谁的 |
|---|---|
| `~/.dsh/model-vision.web.status.json` | `web` profile（`dsh web` / 桌面版默认用这个） |
| `~/.dsh/model-vision.desktop.status.json` | `desktop` profile |
| `~/.dsh/model-vision.status.json` | 0.5.2 之前写的旧文件名，仍然会被认 |

看最新的那个：

```bash
cat ~/.dsh/model-vision.web.status.json
```

## 只看 `message` 一行

那是给你写的人话，覆盖 90% 的情况：

| `message` 说什么 | 意思 |
|---|---|
| 补了 N 个的「输入类型：图片」 | 正常干活，补了 N 个 |
| 没有要改的 | 正常，你配的模型都已经对上了 |
| 本来可以补 N 个……但只看不写模式（dryRun）开着 | 你把 `dryRun` 打开了，它只看不动 |
| 出错了：…… | 后面跟的就是原因 |
| 没有可检查的模型 | 还没配供应商，或者没点过「获取可用模型」 |

## 要追细节时看这几个字段

| 字段 | 大白话 |
|---|---|
| `wrote` | 这次有没有真的改东西 |
| `routes[].changes` | 改了哪几个模型 |
| `routes[].held` | 明明能改但故意没动的（你自己勾过「只要文字」，它尊重你） |
| `routes[].listed` | 网关报了几个模型（0 = 网关没连上或没公布） |
| `routes[].credential` | 用的哪份 key（`file` = 本地凭据文件，`absent` = 没找到） |
| `routes[].probeSkipped` | 超出单次上限跳过的个数，再点一次会接着测 |
| `routes[].probeUnknown` | 问不出结论的个数（模型答非所问），这些没写声明 |
| `error` | 出了什么错（没有就是 `null`） |

## 按症状查

| 现象 | 先看哪 | 常见原因 |
|---|---|---|
| 某个模型没被勾上 | `routes[].held` | ① 你自己勾过"只要文字"，插件尊重你的选择 ② 网关没说明它支持图片 ③ 它确实只能读文字 |
| 一个都没勾上 | `listed` 是不是 0 | 网关地址填错、服务没开，或者网关压根不公布模型清单 |
| 报 `401` | `credential` | 没找到这家的 key。把 key 填进「模型」设置页，或确认网关不需要 key |
| 勾上了，贴图还是失败 | — | 网关说支持但实际不支持。把那个模型的「图片」取消掉，或去网关那边确认 |
| 模型名太长 / 不想看标注 | — | 配置里 `badgeSuffix: ''`，重启后标注会自己撤掉（它只摘自己加在末尾的那一段） |
| 改了 5 分钟才生效 | `updatedAt` | 正常节奏就是这样；想立刻生效就重启 DSH |
| 点了按钮报「超出上限跳过 N 个」 | `probeSkipped` | 单次探测有上限（默认 40 个）。再点一次会接着测（已测过的不会重来），或把 `maxProbes` 调大 |
| 探测显示「没结论」 | `probeUnknown` | 模型没正面回答颜色。不会被误标成"只能读文字"，你手动勾一下即可 |
| 按钮不见了 | 设置 → 模型，列表最下面 | 先重启 DSH。如果某个 DSH 版本改了这个位置，插件会自动退成「设置 → 视觉能力」单页，功能相同 |
| 按钮说「后台服务没响应」 | — | 宿主半边没挂上，重启一次 DSH |

## 只想看它会改什么，不写

```bash
node tools/preview.mjs --profile web
```

只读：读配置、问一次网关、把「会改哪几行」打出来，一个字节都不写。DSH 开着也能安全跑。

## 逐项自检

```bash
node tools/check.mjs --profile web
```

会逐项告诉你：依赖声明了吗、挂进 bundles 了吗、链接就位了吗、补丁里有没有 `llm-pi-ai` 这一行、状态文件写了没。

## 配置被写坏了怎么回滚

写之前先备份：

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak
```

出问题直接覆盖回去：

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml.bak ~/.dsh/profiles/web/cordis.patch.yml
```

插件只写两样东西：`input`（文字/图片）和模型名末尾的「· 可看图」。
所以即使不备份，手工把这两样删掉也能恢复原样。
