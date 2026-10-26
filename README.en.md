<div align="center">
  <img src="https://raw.githubusercontent.com/charovo0059/dsh-model-vision/main/assets/icon-180.png" width="96" alt="dsh-model-vision icon">

# dsh-model-vision

**Lets DSH recognise which models can actually see images.**

Models that accept images get the "Image" input type checked automatically, and a
`· 可看图` marker after their name — no clicking through every model by hand, and
it survives the next "Fetch available models".

No extra CLI to install, no second API key, no need to switch gateways.
It only puts back a capability your gateway **already advertises** but DSH dropped.

[![test](https://github.com/charovo0059/dsh-model-vision/actions/workflows/test.yml/badge.svg)](https://github.com/charovo0059/dsh-model-vision/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?style=flat-square)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![Stars](https://img.shields.io/github/stars/charovo0059/dsh-model-vision?style=flat-square&color=08C)](https://github.com/charovo0059/dsh-model-vision/stargazers)

</div>

<img src="https://raw.githubusercontent.com/charovo0059/dsh-model-vision/main/docs/screenshot.png" width="100%" alt="Settings → Models; the last row is the Detect and fill in vision capability button">

---

## You may be hitting this

- You paste an image and DSH answers "this model does not support image input", or the image is silently ignored
- Your gateway's docs say a model takes images, but DSH shows no "Image" option for it
- You checked "Image" by hand once, and the next "Fetch available models" cleared it

**Why**: when DSH reads a model catalog it keeps only the name, context window and
output limit — it **drops the modality**. Every fetched model therefore falls back
to text-only, and an image request is rejected before it leaves the client.

This plugin puts that field back.

> **Good fit**: you use a third-party gateway / relay / self-hosted server (any
> OpenAI-compatible endpoint) and want image input to work.
> **Not a fit**: the model genuinely cannot see images. This plugin will not teach
> a text-only model to see.

**What it does not do** (so you can install it without worry):

- It does not make a text-only model see images
- It does not fill in API keys, and does not touch model names (except that trailing marker), context windows or pricing
- It does not guess a capability when the gateway says nothing
- It contacts no third-party host, uploads no conversation content, and has no telemetry

---

## Install

Restart DSH afterwards.

**Settings → Plugins → Plugin Market** → search `dsh-model-vision` → Install.

> If it is not listed yet (or you cannot find it), use one of the methods below.

<details>
<summary>From GitHub / from a local clone / self-check / dry run</summary>

### From GitHub

```bash
dsh plugin --profile web add github:charovo0059/dsh-model-vision
```

This also registers the plugin in `dsh.profile.bundles`; no config editing needed.
Replace `web` with your profile name if you use a different one.

### From a local clone (when you are changing the code)

```bash
git clone https://github.com/charovo0059/dsh-model-vision.git
dsh plugin --profile web add link:<absolute path to the clone>
```

### Self-check after installing

If you are unsure which step is missing:

```bash
node tools/check.mjs --profile web
```

### See what it would change before installing

```bash
node tools/preview.mjs --profile web
```

Read-only: reads your config, asks the gateway once, prints the lines it would
change — **writes nothing**. Safe to run while DSH is open.

</details>

---

## Usage

**It works in the background. You do not have to click anything.**

It reconciles at three moments:

| When | What |
|---|---|
| 3 s after DSH starts | Sweeps the models already configured and fills in what is missing |
| Every time you click "Fetch available models" | Fills in the newly fetched models within 5 s |
| Every 5 minutes | Reconciles again, so upstream capability changes are picked up |

To check right now:

> **Settings → Models** → scroll to the bottom of the model list → click **Detect and fill in vision capability**

The result appears in place (one sentence plus an expandable detail list).

### How it decides

1. **Read what the gateway says first** — if it declares a modality, that wins. Cheap, and costs nothing.
2. **Only probe the models the gateway says nothing about** — send a solid-colour image and ask what colour it is, over two different colours:
   - Names a colour it was actually shown → it can see images
   - Names a different colour (shown red, answers "purple") → it cannot see images, recorded as text-only
   - Names no colour at all (answers with a paragraph) → **inconclusive**, nothing is written

**Silence is not the same as text-only.** If the gateway is silent and the probe
is inconclusive, the plugin writes nothing — better nothing than wrong.

Questions you probably have:

| Question | Answer |
|---|---|
| Will it change my selections? | No. It only fills in the "Image" input type; your model selection is untouched |
| Will it burn quota? | Only models whose capability the gateway did not declare, at most two tiny requests each (64×64 solid colour). At most 40 per run; beyond that it shows "skipped N" |
| Will it probe the same model again? | No. Verdicts are cached: 7 days for "yes", 1 day for "no" |
| Why is a model "inconclusive"? | The model did not answer the question (e.g. replied with a paragraph and named no colour). It is **not** treated as text-only — nothing is written rather than something wrong |

---

## Supported gateways

Anything DSH can use as a provider should work — it does not assume paths or field names.

| Your service | How the model list is found | One-click probe |
|---|---|---|
| Official / relay (OpenAI-compatible) | `/models`, falling back to `/v1/models`, `/model/info` | ✅ |
| Self-hosted vLLM / LM Studio / one-api / new-api | same (with or without `/v1` in `baseURL`) | ✅ |
| Anthropic protocol (`/v1/messages`) | `/v1/models?limit=1000` | ✅ |
| Ollama | `/api/tags` (matched by model name) | ✅ (only if it answers correctly) |
| Responses protocol (`/responses`) | `/models` | List only, no probing (its image format differs; guessing would misfire) |

For the exact field names it understands, see [docs/how-it-works.md](docs/how-it-works.md).

---

## How to tell it is working

**Most direct**: Settings → Models → open a model you know accepts images →
"Image" is already checked under Input types.

**Read the sentence it leaves behind**: after every run it writes a record. The
`message` line is the human-readable one:

```json
{
  "message": "扫了 58 个模型（网关报了 191 个），补了 34 个的「输入类型：图片」"
}
```

There are only a few possible messages:

| `message` says | Meaning |
|---|---|
| 补了 N 个的「输入类型：图片」 | Worked normally, filled in N models |
| 没有要改的 | Normal, every configured model already matches |
| 本来可以补 N 个……但只看不写模式（dryRun）开着 | You turned on `dryRun`; it looked but did not write |
| 出错了：…… | The reason follows |
| 没有可检查的模型 | No provider configured, or "Fetch available models" was never clicked |

The record lives at `~/.dsh/model-vision.<profile>.status.json` (for the `web`
profile that is `model-vision.web.status.json`). For the detailed fields
(`wrote` / `routes[].changes` / `credential`) see
[docs/troubleshooting.md](docs/troubleshooting.md).

---

## Will it break my config

- **It writes one field only** — the input type — and stops there
- Nothing to change → **not a byte is written**
- It compares line by line before writing, so comments, field order and `!!js` expressions survive
- If something ever goes wrong: back up `~/.dsh/profiles/web/cordis.patch.yml` first, restore it to roll back
- To watch without writing: set `dryRun: true`; it still records, but touches no file

What it touches:

| It needs | Used for |
|---|---|
| Read your config | See the input type each model currently declares |
| Write your config | Only `input` (text/image) and the `· 可看图` suffix on the model name |
| Read local credentials (`refs` in `~/.dsh/.credentials.yaml`) | To authenticate against the API endpoint you configured |
| Reach that API endpoint | Read the model list; send two 64×64 solid-colour images when probing |

**No third-party host is contacted**, no conversation content is uploaded, no
session history is read, and there is no telemetry.

---

## Troubleshooting

| Symptom | Look at | Likely cause |
|---|---|---|
| A model is not checked | `held` in the status record | ① You marked it text-only yourself; the plugin respects that ② The gateway does not declare image support ③ It really is text-only |
| Nothing is checked | Whether `listed` is 0 | Wrong endpoint, service down, or the gateway publishes no model list |
| `401` | `credential` in the status record | No key found for this route. Add it in Settings → Models, or confirm the gateway needs none |
| Checked, but image requests still fail | — | The gateway claims support it does not have. Uncheck "Image" for that model, or ask the gateway operator |
| Model names too long / no marker wanted | — | Set `badgeSuffix: ''`; the marker is removed after a restart (it only strips the suffix it added) |
| Changes take 5 minutes to appear | `updatedAt` | That is the normal cadence; restart DSH to apply immediately |
| "Skipped N over the limit" | That line in the result | There is a per-run probe cap (default 40). Click again to continue (already-probed models are not retried), or raise `maxProbes` |
| A model shows "inconclusive" | That line in the result | The model did not answer with a colour. It is not mislabelled as text-only; check it manually |
| The button is gone | Settings → Models, bottom of the list | Restart DSH first. If a DSH version moved that slot, the plugin falls back to a "Vision capability" settings page with the same function |
| The button says "backend not responding" | — | The host half is not mounted; restart DSH |

---

## Uninstall

```bash
dsh plugin --profile web remove dsh-model-vision
```

Restart DSH and it is gone — `dsh plugin remove` also drops it from
`dsh.profile.bundles`, so no manual config editing is needed.

The "Image" checkboxes that were filled in stay — they are now ordinary entries in
your own config and the plugin does not roll them back. Uncheck them in the
settings page if you want them gone.

---

## Configuration (usually unnecessary)

It works out of the box. To tune it, add an override in
`~/.dsh/profiles/web/cordis.patch.yml`. **The `name` line must be exactly
`dsh-model-vision`**, otherwise the entry is skipped silently:

```yaml
- id: model-vision
  name: dsh-model-vision
  config:
    mode: fill               # fill = only fill gaps (default); sync = also correct a stale declaration
    routes: []               # [] = all providers; or list specific route names
    dryRun: false            # true = look only, never write
    intervalMs: 300000       # reconcile every 5 minutes
    watchMs: 5000            # check the composed config every 5 seconds
    badgeSuffix: ' · 可看图'  # marker after the name; '' = no marker
    probe: false             # true = probe in the background too (default probes only on the button)
    probeRounds: 2           # colours asked per model
    maxProbes: 40            # probe cap per run
    timeoutMs: 15000         # model-list timeout
    probeTimeoutMs: 30000    # per-probe timeout
    statusFile: ''           # '' = default location; false = write nothing
```

---

## Contributing

- Found a bug or want a feature → [open an issue](https://github.com/charovo0059/dsh-model-vision/issues)
- Sending a PR → read [CONTRIBUTING.md](CONTRIBUTING.md) first, then run `npm test`
- New gateway or field spelling it should recognise but does not → open an issue with the relevant fragment of your gateway's `/models` response; that is the most useful report

For implementation details (why DSH drops the field, why the marker lives in the
name, the three triggers, the two write channels, the one-click endpoint, running
the tests) → [docs/how-it-works.md](docs/how-it-works.md)

## License

[MIT](LICENSE)
