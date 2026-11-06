# dsh-token-steward · model matrix orchestrator

Put **any** OpenAI-compatible service into one matrix — official APIs, free mirrors,
proxy-switched endpoints, or an expensive all-rounder — then route by task nature,
fail over automatically, and see usage and cost at a glance.

## Why a gateway

DSH's `llm-pi-ai` adapter captures `fetch` when it constructs its SDK client, and the
request body handed to it is deep-frozen (see the architecture doc of the ecosystem plugin `dsh-provider-proxy`, github.com/apolenkov/dsh-provider-proxy).
A plugin therefore **cannot reliably rewrite "which model this call uses"**, and cannot
retry a 429 against a different model.

This plugin works one layer below: it runs an OpenAI-compatible gateway on `127.0.0.1`
and points `llm-pi-ai`'s `baseURL` at it. Routing, fallback and metering all live in the
gateway; sessions, subagents and tool calls need no change at all.

```
agent loop / subagent ──► ctx.llm ──► llm-pi-ai ──► 127.0.0.1:<port>/v1
                                                        │
                                              router + health state machine
                                                        │
                              ┌─────────────┬───────────┴───────────┐
                          deepseek        agnes                mirror / frontier
```

## Three modes

| Mode | Primary order | Tie-breakers |
|---|---|---|
| **frugal** | `cost_level`: free > low > medium > high | latency → idle → quality |
| **balanced** | `fast` tag + measured latency | in-flight → **burst spreading** |
| **max_power** | `quality_rank` | capability count → context window |

Efficiency spreading is decisive, not a preference: within one burst (`idea_swarm`
starting four agents at once) an already-dispatched model is pushed behind, so the four
requests land on four different upstreams instead of all hitting the same 429.

## Failure handling

| Upstream condition | Behaviour |
|---|---|
| 429 | exponential cooldown (capped at 16x), this call moves on immediately |
| repeated timeout / 5xx / transport | circuit opens at threshold, half-opens later, resets only on success |
| 401 / 403 | circuit opens on the first failure (a broken key will not heal by retrying) |
| 400 with context wording | classified as context overflow, routes to a larger window |
| failure after first byte | **never retried** — a resend duplicates side effects |
| every candidate failed | 502 with a readable reason, no uncaught throw |

## Exact-match cache (opt-in)

`routing.cache.exact_match: true` (off by default) serves byte-identical repeats of
simple calls locally: the same prompt within its TTL replays the previous response
bytes — nothing leaves the machine, nothing is billed, and the health state machine
never sees a fake sample. The key covers the prompt-defining fields plus the virtual
id, the effective mode and the streaming shape, so a mode switch or a stream/non-stream
change invalidates naturally. Three hard rules: tool-carrying requests are never cached,
oversized prompts are never cached, and a model taken offline invalidates its entries.

## Metering

`dsh-usage`'s daily ledger is the single source of truth for tokens; this plugin keeps a
separate **routing ledger** (who was chosen, how often it degraded, per-model latency).
Three strictness rules:

1. **Unpriced is not free** — a model without `pricing` shows `—` and the panel reports
   "N models unpriced".
2. **Currencies are never summed** — with both CNY and USD present the total shows `—`
   rather than adding 1.5 yuan to 2.5 dollars.
3. **Unavailable says so** — without `dsh-usage` the section reads "metering unavailable",
   not 0.

## Install

```bash
cd ~/.dsh/profiles/desktop && pnpm add dsh-token-steward
# then insert the row from the package's cordis.patch.yml
```

After the first launch:

1. edit `$DSH_HOME/token-steward/model_pool.yaml` (fields in `model_pool.example.yaml`);
2. read `baseUrl` and `token` from `$DSH_HOME/token-steward/gateway.json`;
3. point `llm-pi-ai` at the gateway:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      steward:
        displayName: Steward Matrix
        api: openai-completions
        apiKeyEnv: STEWARD_LOCAL_TOKEN
        baseURL: http://127.0.0.1:<port>/v1
        models:
          - { id: 'steward:auto', name: 'Steward Auto' }
          - { id: 'steward:frugal', name: 'Steward Frugal' }
          - { id: 'steward:balanced', name: 'Steward Efficiency' }
          - { id: 'steward:max_power', name: 'Steward Max Power' }
```

Restart the DSH service for the profile change to take effect.

## Virtual model ids

| id | Meaning |
|---|---|
| `steward:auto` | route by the current global mode (switching mode switches this) |
| `steward:frugal` / `steward:balanced` / `steward:max_power` | pin one mode |
| `steward:pin/<provider>/<model>` | pass through to one model (still metered, still fails over) |
| `steward:alias/<name>` | a custom intent from `routing.aliases` |

A real model id from the matrix is also accepted and passes straight through.

## UI

- **Floating ball** (`shell.overlay`): ring colour is the current mode, badge is today's
  spend (token count when unpriced, `—` when unmetered). Click to expand, long-press to
  cycle modes.
- **Expanded panel**: four metric cards, the model array grouped by cost tier, a route
  monitor that draws fallback chains as `a → b`, and the agent lanes.
- **Settings page** (`settings.section`): config path and status, gateway URL and token
  with one-click copy, default mode, ledger retention.

Polling stops when the panel is collapsed or the page is hidden.

## Security

- the gateway binds `127.0.0.1` only, on a system-assigned port;
- every launch mints a random local token; clients must send
  `Authorization: Bearer <token>`;
- credentials use `env:` / `file:` / `literal:` references; the expanded secret stays
  **in memory only** — never in logs, snapshots, or any wire document;
- panel APIs reject every non-loopback request.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | off means nothing is mounted |
| `poolPath` | `$DSH_HOME/token-steward/model_pool.yaml` | matrix file |
| `retainDays` | `180` | routing ledger retention |
| `usagePollMs` | `15000` | how often the dsh-usage ledger is read (min 2000) |
| `gatewayPort` | `0` | gateway port, 0 = system-assigned |

## Package layout

```
lib/index.js    host half (ESM), loaded directly by the loader row
lib/client.js   client half, a window.__ModuleLoader__ factory with CSS injected as a style tag
src/            sources (kept so a profile can link:/ debug against them)
```

## Development

```bash
npm install
npm run build      # emits lib/index.js and lib/client.js
npm test           # builds first, then runs every assertion (358 cases, no external services)
npm run typecheck  # tsc --noEmit (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
```

The M0 probe scripts in `probes/` run as-is against a real DSH install (asar extraction,
gateway round-trip, streaming usage buckets, colon-bearing model ids). `probes/m0-rewrite-probe/`
is a separate one-shot probe plugin that censuses the `llm/stream` waterfall shape — the
evidence base for the planned `agent/request` identity injection (see `docs/m0-probes.md`).

Design records: `docs/architecture.md`, `docs/m0-probes.md`, `docs/m1-report.md`, `docs/ui-plan.md`.
License: MIT (`LICENSE`). Release history: `CHANGELOG.md`.
