# 参与开发

感谢你愿意花时间。这个插件的目标很小很具体：**让 DSH 在拉模型清单时，别把「能看图」这件事丢掉。**
任何改动只要不偏离这个目标、不弄坏别人的配置，都欢迎。

## 提 issue

最有用的一类 issue 是**「我的网关能看图，但它没认出来」**。请带上：

1. 你填的 API 协议（OpenAI Chat Completions / Anthropic / Ollama / Responses）
2. 网关 `/models` 返回里**那一个模型**的原文片段（去掉 key 和域名）
3. `~/.dsh/model-vision.<profile>.status.json` 里的 `message` 和 `routes[0]` 两个字段（`<profile>` 通常就是 `web`；找不到就贴 `~/.dsh/` 下所有 `model-vision*.status.json`）

有这三样，基本能一眼定位是「网关用了它不认识的写法」还是「探测判定错了」。

**请不要**在 issue 里贴 API key、完整 baseURL（含内网域名）或对话内容。

## 改代码

```bash
git clone https://github.com/charovo0059/dsh-model-vision.git
cd dsh-model-vision
npm test          # 68 个用例，零依赖、不联网
```

没有 `npm install` 这一步——这个包故意零依赖，因为它装在 profile 目录之外，
那里 Node 解析不到宿主 harness 的 `node_modules`，所以只允许用 `node:` 内置模块。

### 三条硬规矩

1. **只写 `input` 和模型名末尾的标注。** 别的字段一个字节都不能动，注释、字段顺序、`!!js` 表达式都要保留。
2. **沉默不等于「只能读文字」。** 网关没说、探测没问出结论，就不写声明。猜错一次，用户要等报错才发现。
3. **`inject` 必须是数组。** 写成 `{ required, optional }` 会被 cordis 当成「服务名 → 配置」映射，插件会静默不加载。

### 改了这些地方，请连带改测试

| 你动了 | 必须过 |
|---|---|
| `lib/index.js` 里的 `RPC_PATH` / `RPC_HEADER` / `PROTOCOL_VERSION` | `test/contract.test.mjs`（它会把两边名字逐项比对） |
| `lib/client.js` 里的 `CONTRACT` | 同上 |
| 能力识别的新字段名 | `test/vision.test.mjs`，并加一条对应用例 |
| 探测的判定逻辑 | `test/probe.test.mjs`，四种判定（能看 / 不能看 / 没结论 / 故障）都要覆盖 |
| 写文件的路径 | `test/wiring.test.mjs`，两条写通道都要跑 |

### 提交前

```bash
npm test
node tools/check.mjs --profile web   # 装了插件的话，检查接线是否完整
```

提交信息用中文或英文都行，写成「做了什么 + 为什么」：

```
fix: 认出 vLLM 的 architecture.input_modalities

自建 vLLM 把模态放在 architecture 下面，之前只读了顶层 input，
导致这类网关一律被判成沉默。
```

## 加一个网关的识别写法

如果某个网关公布能力的方式不在下面这张表里，加进来只需要动 `lib/index.js` 的识别函数：

| 类型 | 字段（按优先级） |
|---|---|
| 模态列表 | `input` → `input_modalities` → `inputModalities` → `architecture.input_modalities` → `modalities.input` |
| 布尔标记 | `vision` → `supports_vision` → `image_input` → `capabilities.vision` |

加完请同时补一条 `test/vision.test.mjs` 用例，用最小的 JSON 片段说明「它这么写，应该被判成能看图 / 只能读文字 / 沉默」。

## 关于截图

`docs/screenshot.png` 是**真实截图**，不是画的。界面上任何一处文案变了，这张图就该重截，
否则 README 和市场详情页会跟实际界面对不上。

`dsh web` 用进程令牌 cookie 鉴权，无头浏览器拿不到带令牌的地址（直接访问会 401），
所以这张图只能人工在界面上截：设置 → 模型 → 列表最下面那一行。

## 文档放在哪

| 文件 | 给谁看 |
|---|---|
| `README.md` / `README.en.md` | 使用者。两版章节必须一一对应同序 |
| `docs/troubleshooting.md` | 出问题的使用者：状态文件字段表、按症状查、回滚 |
| `docs/how-it-works.md` | 想深挖的人：为什么 DSH 会漏记、三种触发、两条写通道、跑测试、跨版本维护 |
| `CONTRIBUTING.md` | 贡献者 |
| `docs/publish-checklist.md` | 维护者自己发布时用 |

改了一处实现，对应那篇文档也要跟上——尤其是 `docs/how-it-works.md` 里的字段表和测试数量。

## 许可证

贡献的代码按 [MIT](LICENSE) 授权。
