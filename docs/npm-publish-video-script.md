# 发 npm 的准备工作 + 录给小白的视频脚本

> 这篇有两块：**先看「准备清单」**（真正要做的事），**再看「分镜脚本」**（可以照着念、照着录）。
> 所有数字都来自这台机器上这个包的真实输出，不是估的。

---

# 第一部分：要准备什么

## 一句话理解

npm 就是「全世界程序员的公共货架」。把包传上去，别人就能用一条命令装：

```
dsh plugin --profile web add dsh-model-vision     ← 而不是 github:charovo0059/dsh-model-vision
```

## 清单（7 项，按重要性排）

| # | 准备什么 | 我们这份的状态 |
|---|---|---|
| 1 | **npm 账号 + 邮箱验证** | ❌ 还没注册（`npm whoami` 报 `ENEEDAUTH`） |
| 2 | **开 2FA**（两步验证） | ❌ 账号还没建；建完必须开，npm 强制 |
| 3 | **包名没被占** | ✅ 已查：`dsh-model-vision` 在官方源是空的（404），不需要加 `@你/` 前缀 |
| 4 | **删掉 `private: true`** | ✅ 已删（这个字段是 npm 拒绝发布的直接原因） |
| 5 | **版本号**（每次发布必须变大） | ✅ `0.5.1` |
| 6 | **`files` 白名单**（决定哪些文件被传上去） | ✅ 已收窄：17 个文件 / 57.5 kB |
| 7 | **发布目标指向官方源** | ✅ 已锁 `publishConfig.registry`（见下，这是本机最大的坑） |

## 为什么第 7 项必须做

你这台机器的 npm 默认源是**国内镜像**：

```
~/.npmrc → registry=https://registry.npmmirror.com
```

镜像**只能下载、不能发布**。直接 `npm publish` 会被 403 拒，而报错信息不会告诉你"因为你在用镜像"，新手很容易卡死。

已经在 `package.json` 里写死了：

```json
"publishConfig": { "registry": "https://registry.npmjs.org/", "access": "public" }
```

所以 `npm publish` 会强制打到官方源。**但登录也要指官方源**，否则拿到的是镜像的 token：

```bash
npm login --registry=https://registry.npmjs.org
```

## 白名单前后对比（视频里很好用的一幕）

|  | 传了哪些 | 体积 |
|---|---|---|
| 改之前 | lib + test + tools + **docs（两张截图 300KB）** | **304.3 kB** |
| 改之后 | 去掉 `docs/` | **57.5 kB** |

截图不用进包——npm 页面上的图会回源到 GitHub 仓库去读，钱白花。

## 完整命令（复制就能跑）

```bash
cd "E:/dsh工作区/dsh-model-vision"

# 0. 先确认包名还在（万一被人抢了就得改名或加前缀）
npm view dsh-model-vision version          # 期望 404 Not found

# 1. 登录官方源（会开浏览器）
npm login --registry=https://registry.npmjs.org

# 2. 演练：不上传，只检查
npm publish --dry-run
#   看到 Publishing to https://registry.npmjs.org/ 就对了
#   这一条也会自动跑一遍测试（prepublishOnly）

# 3. 真发
npm publish

# 4. 验证
npm view dsh-model-vision version
npm view dsh-model-vision dist.tarball
```

发完把 GitHub 上的安装命令换成 npm 版，读的人会少一步：

```bash
dsh plugin --profile web add dsh-model-vision
```

---

# 第二部分：视频分镜脚本（约 8 分钟）

> 口播是**可以直接念**的，不用改写。方括号里是字幕/画面提示。

## 0:00–0:40 开场：为什么要发 npm

**画面**：浏览器打开 npmjs.com，搜一个你常用的包，停在安装命令那一行。

**口播**：
> 你写了个插件，想让别人用。最直接的办法是把 GitHub 地址发给他。
> 但 npm 是程序员的公共货架——传上去之后，别人只要一条命令就能装，不用 clone、不用找路径。
> 今天我把整个流程走一遍，包括三个新手一定会踩的坑。

[字幕：一条命令 vs 一堆步骤]

## 0:40–1:50 第一步：账号（含邮箱验证和 2FA）

**画面**：npmjs.com 注册页 → 收邮件点验证 → 头像 → Access Tokens/2FA 设置 → 用手机扫码绑定。

**口播**：
> 第一件事，注册账号。注意两点：
> 邮箱必须点验证链接，不验证发不了包；
> 然后开启两步验证，也就是 2FA。npm 对发布这个动作是**强制**要求 2FA 的，这一步别跳。
> 绑一个手机上的验证器 App，以后每次发布会让你输六位数。

[字幕：邮箱验证 + 2FA = 发布前置条件]

## 1:50–2:40 第二步：确认包名没被占

**画面**：终端跑 `npm view dsh-model-vision version`，显示 404。

**口播**：
> 包名是全球唯一的，先查一下有没有人用过。
> 查不到、报 404，说明这个名字是你的了。
> 如果被占了，有两个办法：换个名字，或者加你的用户名做前缀，变成 `@你的名字/包名`。

[字幕：404 = 可用；被占就加 @scope]

## 2:40–3:40 第三步：改 package.json（五个地方）

**画面**：`package.json` 全屏，逐条高亮。

**口播**：
> 打开 package.json，只看五个地方。
> 第一，`name`，就是包名。
> 第二，`version`，版本号，每次发布必须比上一次大，否则会被拒。
> 第三，**把 `private` 删掉**——很多人卡在这，`private: true` 是"这个包不发布"的意思，npm 会直接拒绝。
> 第四，`files`，这是白名单，决定哪些文件会被传上去。你现在看到的这个包，我加了两张截图进去，包变成 300 多 K；
> 我把截图排除掉，变成 57 K——因为 npm 页面上的图会回到 GitHub 去读，不用重复上传。
> 第五，`publishConfig`，把发布地址写死成官方源。为什么？看下一个坑。

[字幕：name / version / 删 private / files / publishConfig]

## 3:40–4:30 第四步（坑一）：你的 npm 源是镜像

**画面**：`npm config get registry` → `https://registry.npmmirror.com`；然后 `npm publish` 报 403 的画面（示意）。

**口播**：
> 这是国内用户最容易踩的坑。
> 为了下载快，很多人把 npm 源换成了国内镜像。镜像只能下载，**不能发布**。
> 你以为是自己没登录，其实是发错了地方。
> 解决办法两个：要么发布时加 `--registry https://registry.npmjs.org`，
> 要么像我这样，在 package.json 里写死 `publishConfig`，一劳永逸。

[字幕：镜像 = 只读；发布必须打官方源]

## 4:30–5:20 第五步（坑二）：登录也要指官方源

**画面**：`npm login --registry=https://registry.npmjs.org`，浏览器授权 → 终端显示 `Logged in as ...`。

**口播**：
> 同理，登录也要指定官方源。
> 如果你只是 `npm login`，登录态存到镜像那儿去了，发布的时候照样 401。
> 登录成功之后，终端会显示你的用户名，看到这行才算过。

[字幕：login 和 publish 必须同一个源]

## 5:20–6:00 第六步：先演练，再真发

**画面**：`npm publish --dry-run` 的输出，红框圈出 `Publishing to https://registry.npmjs.org/` 和 `total files: 17`。

**口播**：
> 真发之前，先演练一遍。加 `--dry-run`，它不上传，只告诉你"会传哪些文件、传多大、发到哪个源"。
> 这一步能救命：我见过有人把整个 node_modules 传上去的。
> 确认三行：发到官方源、文件数量对、体积合理。
>
> 另外我在这里挂了个钩子：`prepublishOnly`，发布前自动跑一遍测试。测试挂了就发不出去，比发出去之后才发现问题好。

[字幕：dry-run 看三行：源 / 文件数 / 体积]

## 6:00–6:40 第七步：真发 + 验证

**画面**：`npm publish` → 要求输入 2FA 六位数 → 出现 `+ dsh-model-vision@0.5.1`；然后打开 npmjs.com/package/dsh-model-vision。

**口播**：
> 输六位数验证码，回车。
> 看到这行带加号的输出，就是成功了。
> 去网页上刷新，能看到 README、版本号、安装命令——这些都是从你仓库里自动带过来的。

[字幕：+ 包名@版本 = 成功]

## 6:40–7:20 第八步（坑三）：更新版本才能再发

**画面**：`npm version patch` → `0.5.2` → 再 `npm publish`；然后试一次改回 `0.5.1` 发布，报 `EPUBLISHCONFLICT`。

**口播**：
> 改完代码想再发一次，不能直接用原来的版本号，会报冲突。
> 先 `npm version patch` 把版本号加一，再发。
> patch 是修 bug，minor 是加功能，major 是大改。

[字幕：同一个版本号只能发一次]

## 7:20–8:00 收尾：三个别做

**画面**：三条字幕逐条出现。

**口播**：
> 最后三件事，别做。
> 别把 token 写进地址里或者 `.npmrc` 里提交——泄一次要重新生成。
> 别急着 `npm unpublish`，发布 24 小时后就不让删了，删了别人装了也会坏。
> 别在包里放截图和测试数据——白名单写清楚，包越小装得越快。

[字幕：token 别进仓库 / unpublish 有 24 小时限制 / 文件白名单]

---

# 常见报错对照表（当字幕卡用）

| 报错 | 真实原因 | 怎么办 |
|---|---|---|
| `ENEEDAUTH` | 没登录，或登录到了别的源 | `npm login --registry=https://registry.npmjs.org` |
| `402 Payment Required` / `You must sign up` | 名字被占（scoped 包未付费） | 换名或用 `@scope/name` |
| `E403` + `private` 字样 | `package.json` 里有 `private: true` | 删掉这个字段 |
| `E403` + `two-factor` 字样 | 没开 2FA 或没输验证码 | 开 2FA，发布时输六位数 |
| `403 Forbidden - PUT https://registry.npmmirror.com` | 源是镜像 | 加 `--registry`，或写 `publishConfig` |
| `EPUBLISHCONFLICT` | 这个版本号已经发过 | `npm version patch` 再发 |
| `E404` 在 `npm view` 时 | 包名没人用（好事） | 直接用 |
| 包里多了 node_modules | 没写 `files` | 加 `files` 白名单，用 `--dry-run` 复查 |

---

# 这台机器上的当前状态（给下一个执行的人）

- `private` 已删、`publishConfig` 已锁官方源、`files` 已收窄、`prepublishOnly` 已挂测试
- `npm publish --dry-run` 通过：17 个文件 / 57.5 kB / 目标 `https://registry.npmjs.org/`
- **还没注册账号、没登录、没真发**（这三步需要人做，或者由有登录态的人代做）
