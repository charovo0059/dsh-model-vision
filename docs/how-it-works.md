# 它是怎么做的

这份文档给想深挖的人。只想用的话看 [README](../README.md) 就够了。

## 为什么 DSH 会漏记这一项

DSH 的「获取可用模型」读的是 `@deepseek-ai/dsh-llm-pi-ai` 里的 `readListing()`，它每条只保留四个字段：

```js
id / name / contextWindow / maxTokens
```

`input`、`input_modalities`、`architecture.input_modalities`、`vision` —— 一个都不解析。
于是每个模型走 `entry.input → 内置目录 → defaultInput`，而 `DEFAULT_INPUT = ["text"]`，
带图请求在附件阶段就被拒：

```
LlmError: pi-ai model "<id>" does not support image input
(category: UNSUPPORTED_CONTENT)
```

本插件读网关自己公布的能力，把 `input: [text, image]` 写回 `llm-pi-ai` 的模型条目。

## 它认哪些字段写法

判断能力时按这个顺序找，**第一个真正表态的胜出**：

- **模态列表**：`input` → `input_modalities` → `inputModalities` → `architecture.input_modalities` → `modalities.input`
- **布尔标记**：`vision` → `supports_vision` → `image_input` → `capabilities.vision`

**全程沉默 = 没结论**，不猜。这是这个插件最重要的一条规矩：沉默不等于「只能读文字」。

网关没写的时候才发图探测。探测的判定规则：

| 模型回答 | 判定 |
|---|---|
| 说对了给它的那个颜色 | 能看图 |
| 说了别的颜色（任何颜色，不限于调色板里的） | 只能读文字 |
| 一个颜色都没提 | **没结论**，不写声明 |

问两轮、两个不同颜色，答对任意一个就算能看图。

## 为什么标注写进名字，而不是画个小标签

`conversation.input.model.label` 是 **single 插槽**，已经被 `dsh-client-ui-deepseek-model-label-1017` 占了；
而 `ModelCatalogModel` 只有 `{ id, name, description, reasoning }`，没有能力字段。
写进名字是唯一在所有地方都看得见的做法——切模型、设置页、会话头部都生效。

## 三种触发

- `start` —— 加载后 3 秒
- `config-change` —— 每 5 秒比对一次组合配置的指纹，变了才请求网关
- `interval` —— 每 5 分钟兜底

> `config-change` 是指纹轮询而不是文件监听：profile 补丁路径的监听属于 Loader（`hmr.watchConfig` 拒绝第二次注册），插件插不进去。
> 轮询只读组合后的配置、不打网络。写完一次后立刻采纳新指纹，避免自己的写入回声成第二次空 sweep。

## 两条写通道

优先 `ctx.configEditor.edit()`（带文件锁、schema 校验、Loader 重组）；
热重载时报 `HMR transactions cannot be nested` 时，回落到按行改 `cordis.patch.yml`
（临时文件 + rename，保 CRLF、保注释、绝不写重复的 `input` 键）。

## 凭据解析

`credentials` 服务 → 环境变量（`apiKeyEnv`）→ `~/.dsh/.credentials.yaml` 的 `refs`。
实际用了哪条会记进状态记录的 `credential`，401 时先看它。

## 一键按钮的接口

`POST /plugins/model-vision/detect`（仅本机、需 `x-model-vision` 头、只接受 POST）。

- body `{}` → 探测并补充
- `{"dryRun":true}` → 只看不写
- `{"route":"salt"}` → 只测一家

返回 `{ ok, message, routes: [{ changes, held, probedModels, error }] }`，设置页只渲染这个。

## 状态文件按 profile 分开

所有 profile 共用一个 `DSH_HOME`，所以状态文件带上 profile 名：
`~/.dsh/model-vision.<profile>.status.json`、`~/.dsh/model-vision.<profile>.probe.json`。
不分开的话，启动第二个 `dsh` 会把正在运行那个 profile 的记录换成自己的 pid 和别人的 patch 路径。

宿主没提供 `profileContext` 时回落旧文件名 `model-vision.status.json`（0.5.2 之前写的就是这个）。

## 跑测试

```bash
npm test

node test/vision.test.mjs     # 30 个：解析、决策、按行改文件、CRLF、幂等、人话摘要
node test/wiring.test.mjs     # 10 个：两条写通道、dryRun、凭据、轮询、多 profile 状态文件
node test/probe.test.mjs      # 12 个：图片字节、请求形状、四种判定（能看/不能看/没结论/故障）
node test/oneclick.test.mjs   #  9 个：多路径清单、Ollama 形状、一键端点、缓存与上限
node test/contract.test.mjs   #  7 个：前端与后端对同一批外部名字的约定
```

一共 68 个，全部零依赖、不联网（探测测试用本地假网关）。

## 跨版本维护（DSH 升级后看这一节）

这个插件只依赖四个外部名字，全部集中写在两处：

| 名字 | 宿主 `lib/index.js` | 浏览器 `lib/client.js` |
|---|---|---|
| 请求路径 | `RPC_PATH` | `CONTRACT.rpcPath` |
| 请求头 | `RPC_HEADER` | `CONTRACT.rpcHeader` |
| 协议版本 | `PROTOCOL_VERSION` | `CONTRACT.protocol` |
| 挂载插槽 | — | `CONTRACT.slot`（模型页底部） |

`node test/contract.test.mjs` 会逐项比对两边。任何一边改了名字而另一边没跟上，这个测试立刻失败——不会等到用户点按钮时才发现。

**DSH 升级后只要两步：**

1. 跑 `node test/contract.test.mjs`。全绿 = 接口没变，什么都不用改。
2. 如果红了，看它报哪个名字，改 `CONTRACT` 或宿主导出里那一行即可。

已经内置的两条自愈：

- **插槽被改名 / 移除**：模型页底部那个位置 4 秒内没注册成功，就自动退成「设置 → 视觉能力」单页，用同一个组件渲染，功能一样。
- **后台没挂上**：按钮会直接说「后台服务没响应，重启一次 DSH 再试」，不会静默失败。
