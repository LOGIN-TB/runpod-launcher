# RunPod Launcher

Run your own LLM on rented GPUs, reachable from n8n, an agent, or any
OpenAI-compatible client — and let it sleep when nobody is using it.

A GPU big enough for a 27B model costs roughly **$400/month if you leave it
running**. This project exists to make that number a fraction of itself without
you having to remember to switch anything off.

> **Status: early.** The service, the gateway and the pod image work and are
> covered by tests. The desktop app, the scheduler and the in-app help are not
> built yet. See [the roadmap](#roadmap).

## How it fits together

```
  Desktop app  ──token+TLS──►  Launcher service  ──REST v2──►  RunPod pod
  (Mac/Windows)                (Docker, always on)             vLLM chat  :8000
                                       ▲                       vLLM embed :8001
  n8n · Hermes · OpenClaw ─────────────┘
  Open WebUI · your script      OpenAI API, bearer token
```

Two halves, on purpose:

- The **service** is a small container that lives next to whatever uses the
  model. It holds the credentials, runs the schedule and is the bridge to the
  pod. It keeps running when your laptop is shut.
- The **desktop app** is only the controls. Nothing breaks when it is closed.

Your clients always talk to the service, never to the pod. That matters because
a pod's address (`https://<pod-id>-8000.proxy.runpod.net`) changes every time it
is rebuilt — the service absorbs that so nothing downstream has to be reconfigured.

## Install the service

Nothing confidential goes in a file. The RunPod key, the HuggingFace token and
any webhook URL are typed into the app and stored encrypted. What follows sets
only a port and a TLS mode.

### With Docker Compose

```bash
curl -O https://raw.githubusercontent.com/OWNER/runpod-launcher/main/docker-compose.yml
docker compose up -d
docker compose logs | grep -A4 "Pair the launcher app"
```

Type the pairing code into the app. It works once and expires after 30 minutes.

### With Coolify

**New Resource → Docker Compose**, point it at this repository. Coolify reads
`docker-compose.yml`, assigns a subdomain and issues the certificate itself. The
pairing code appears in Coolify's own UI under the environment variables, as
`SERVICE_PASSWORD_PAIRING` — no digging through logs.

Set `TLS_MODE=proxy` so the service speaks plain HTTP behind Coolify's proxy.
The app then validates the certificate chain normally instead of pinning it,
which matters because Let's Encrypt certificates are renewed every 90 days and a
pinned fingerprint would lock you out after three months.

## Connect a client

Any OpenAI-compatible client works. Point it at the service and give it a client
token from the app:

```bash
curl http://your-server:8080/v1/chat/completions \
  -H "Authorization: Bearer <client-token>" \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen/Qwen3.8-27B-FP8", "messages": [{"role":"user","content":"Hallo"}]}'
```

| Client | Where to put the address |
|---|---|
| n8n | OpenAI credential → *Base URL* |
| Open WebUI | Settings → Connections → OpenAI API |
| LibreChat | `librechat.yaml` → custom endpoint |
| Hermes / OpenClaw | the OpenAI base URL in the agent's model config |
| Python | `OpenAI(base_url=..., api_key=...)` |

**Client tokens can only use the model.** They cannot start a pod or read
settings — so a token leaking out of an n8n workflow cannot rent you hardware.
Device tokens, which the app holds, are what grant control.

## Templates

A template says what to run: an image, a chat model, an embedding model, a GPU,
and how it should sleep. Both model slots are optional and independent — chat
only, embeddings only, or both on one card.

The embedding model is tiny next to the chat model (about 1 GB against 27 GB),
so running both on one GPU costs nothing extra. When only one slot is filled,
the other's share of VRAM goes to it, which directly buys context length.

### Sleep modes

| | Stop & resume | Rebuild each time |
|---|---|---|
| Wake time | 1–2 min | 2–4 min |
| Cost at rest | volume billed at **double** rate | network volume only (~$7/month per 100 GB) |
| GPU on wake | **may come back with none** | any available card |
| Pod address | unchanged | new each time (the gateway hides this) |

RunPod is explicit that a resumed pod can be allocated zero GPUs if capacity
moved on. The service detects that and rebuilds rather than leaving you with a
pod that bills for storage and serves nothing.

## Development

```bash
npm install
npm test
npm run build

# the service
DATA_DIR=./data PORT=8080 ALLOW_UI_ORIGIN=http://localhost:5173 node apps/service/dist/index.js

# the interface, in another terminal
npm run dev -w @runpod-launcher/desktop
```

`ALLOW_UI_ORIGIN` is development only: the built app is served from the same
origin, so production never needs it.

The Tauri wrapper is not built yet — it needs a Rust toolchain (`rustup`). The
interface is finished and runs in any browser meanwhile; wrapping it changes no
application code.

`npm run gen:runpod` regenerates the RunPod API types from
`https://api.runpod.io/v2/openapi.json`. They are generated rather than
hand-written because v1 retires on 2026-11-15 and v2 is still moving — the spec
is the source of truth for paths and payloads.

## Roadmap

- [x] RunPod v2 client, generated from the live spec
- [x] Encrypted credential storage, device pairing, token separation
- [x] OpenAI-compatible gateway with streaming and OpenAI-shaped errors
- [x] Pod image running one or two vLLM servers on a single GPU
- [ ] Walking skeleton: a real answer from a real pod, measured
- [x] German and English throughout, including the service's own messages
- [x] App UI: pairing, overview, template editor with model picker, client tokens, settings
- [ ] Tauri shell (needs `rustup`; the UI itself is done and runs in a browser)
- [ ] In-app help with generated screenshots
- [ ] Scheduler, idle shutdown, wake-on-request, spend limits

## Licence

MIT
