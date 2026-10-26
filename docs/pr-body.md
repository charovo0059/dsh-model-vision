Adds **dsh-model-vision** — fills in the vision capability that `llm-pi-ai`'s "fetch models" reader drops.

`readListing()` keeps only `id` / `name` / `contextWindow` / `maxTokens`, so every model resolved from a fetched catalog falls back to `DEFAULT_INPUT` (`["text"]`), and an image-capable route refuses image input before the request leaves the client.

What it does:

- Reads whatever modality shape the gateway actually publishes: `input`, `input_modalities`, `inputModalities`, `architecture.input_modalities`, `modalities.input`, plus the flat flags `vision`, `supports_vision`, `image_input`, `capabilities.vision`.
- For gateways that publish nothing (self-hosted vLLM, many relays), probes the model with two solid-colour images and only declares it image-capable when it names both colours correctly. An answer that names another colour marks the model text-only; an answer that names no colour leaves it untouched — silence is never turned into a claim.
- Writes back `input: [text, image]` and appends `· 可看图` to the display name, so the composer's model picker shows it (the label slot there is a `single` slot already owned by another plugin, and the catalog entry carries no modality field, so the name is the only surface every view reads).
- One button at the bottom of Settings → Models, plus a background sweep on load, on profile change, and every five minutes. Probe verdicts are cached (7 days yes / 1 day no); a per-run cap keeps a click from spending a large quota.

Safety:

- Writes only `input` and the name suffix. No-ops entirely when nothing differs; CRLF, comments and field order are preserved on the fallback write path.
- `fill` (default) only completes a model that declares no `input` at all — an existing declaration stays its author's decision. `sync` also corrects a stale one.
- Talks only to the API base URL the user configured; no third-party hosts, no telemetry, no conversation content.

Verification: 67 tests (`node test/*.test.mjs`), including a fake harness with both write channels, the probe verdicts against a fake endpoint, and a contract test that fails if the two halves disagree on any external name.

Category: `vision`. Repo declares `dsh.bundle`. Two screenshots declared via `screenshots.json`.
