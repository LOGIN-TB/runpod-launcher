# RunPod Launcher

Run your own LLM on rented GPUs, reachable from n8n, an agent, or any
OpenAI-compatible client — and let it sleep when nobody is using it.

A GPU big enough for a 27B model costs roughly **$400/month if you leave it
running**. This project exists to make that number a fraction of itself without
you having to remember to switch anything off.

> **Status: v0.1.0 — working, unsigned, lightly used.** Everything below is
> built and tested, and has been run against real RunPod hardware: pods started,
> answers streamed, schedules and spend caps triggered. The desktop app is not
> code-signed, so macOS and Windows warn on first launch.

Deutschsprachige Schritt-für-Schritt-Anleitung: **[docs/anleitung.md](docs/anleitung.md)**.

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

> `:latest` follows `main` and is published for amd64 and arm64. Version tags
> (`:0.1.0`) appear with a release.
>
> If a pull ever answers `unauthorized`, the package's visibility is the thing to
> check: GitHub → *Packages* → `runpod-launcher` → *Package settings*. It is
> public here, and published from a public repository it should stay that way.

### With Docker Compose

```bash
curl -O https://raw.githubusercontent.com/LOGIN-TB/runpod-launcher/main/docker-compose.yml
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

## Which application reaches which pod

Every access points at one template, and that is what decides the pod a request
lands on. n8n on a server and an agent on your desk can share one pod, or each
have their own — several accesses on one template is one pod, one access each is
two.

The target hangs on the **access**, not on the application. So moving n8n to
other hardware is a change in the launcher and nothing at all on the n8n side:
the credential it holds stays valid. The **Mappings** screen shows the pairs, the
state of each pod, and — the expensive case — a pod that is running with nothing
pointed at it.

Two consequences worth knowing:

- An access can only wake **its own** pod, and only inside that template's
  schedule. An agent cannot accidentally start the GPU another application rents.
- `/v1/models` lists what that access's own template serves, and reports the
  context window with it, so a client can size its requests instead of guessing.

**Pods at once** in the settings is the ceiling on how many GPUs can be rented
simultaneously. It defaults to 2, and the daily and monthly caps still apply to
all of them together.

## Letting it sleep

The point of the project. A template can carry a schedule — weekdays, hours,
and a timezone that belongs to the schedule rather than to the server, because
a container on a VPS runs in UTC and `07:00` has to mean seven in the morning
where you are.

Three rules run on top of each other:

| | |
|---|---|
| **Schedule** | Up between the hours you set, on the days you pick |
| **Idle shutdown** | Down again after N minutes with no requests, even mid-window |
| **Spend cap** | Down immediately at a daily or monthly limit, whatever else says |

An idle shutdown is not undone by the schedule: once stopped for idleness the
pod stays down until the window comes round again, or until a request arrives.
Getting that wrong produced a start/stop loop that rented a fresh GPU every few
minutes.

A request to a sleeping pod wakes it. The gateway holds the connection while
the engine comes up rather than failing straight away, which is what makes this
work with clients that know nothing about the launcher — an agent has no reason
to call a wake endpoint first. Set the wait longer than a cold start: about five
minutes for a 20 GB model, more if it has to be downloaded.

## Templates

A template says what to run: an image, a chat model, an embedding model, a GPU,
and how it should sleep. Both model slots are optional and independent — chat
only, embeddings only, or both on one card.

The embedding model is tiny next to the chat model (about 1 GB against 27 GB),
so running both on one GPU costs nothing extra. When only one slot is filled,
the other's share of VRAM goes to it, which directly buys context length.

**Tool calling is read from the model, not guessed from its name.** vLLM rejects
any request carrying tools unless it was started with `--enable-auto-tool-choice`
and a matching `--tool-call-parser`, and the right parser depends on the format
the model actually emits. The launcher reads the model's own chat template to
decide: vLLM's documentation lists Qwen2.5 under `hermes`, but a Qwen3.8 template
emits XML and needs `qwen3_xml` — following the documentation would have produced
a parser that cannot read the model's calls at all. Both parsers are shown under
*Advanced* and can be overridden.

**The context length starts at what fits.** The editor offers the largest window
the card can hold with those weights, capped by what the model itself supports.
Both ceilings matter: too large for the card wastes the download, and too large
for the model makes the engine refuse to start — after the weights have arrived.

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

### The desktop app

```bash
npm run app:dev -w @runpod-launcher/desktop      # dev, with hot reload
npm run app:build -w @runpod-launcher/desktop    # a .app / .exe
```

Needs a Rust toolchain (`rustup`). The result is about 3 MB, because the app
uses the operating system's own web view rather than shipping a browser.

`app:build` deliberately produces only the application, not a `.dmg`. Building a
DMG runs an AppleScript that arranges the Finder window, and macOS refuses that
unless Terminal has been granted Automation access to Finder in System Settings
→ Privacy & Security. The failure says nothing about the code, so it is not in
the default script — `npm run app:build:dmg` does the full bundle when the
permission is in place, and CI builds installers for both platforms on tagged
releases.

The device token is kept in the macOS Keychain or the Windows Credential
Manager. In a plain browser there is no such place and it falls back to
`localStorage`, which is fine for development and worse in every other way: any
script on the page can read it, and it travels in a disk backup in clear.

`npm run gen:runpod` regenerates the RunPod API types from
`https://api.runpod.io/v2/openapi.json`. They are generated rather than
hand-written because v1 retires on 2026-11-15 and v2 is still moving — the spec
is the source of truth for paths and payloads.

## Roadmap

- [x] RunPod v2 client, generated from the live spec
- [x] Encrypted credential storage, device pairing, token separation
- [x] OpenAI-compatible gateway with streaming and OpenAI-shaped errors
- [x] Pod image running one or two vLLM servers on a single GPU
- [x] Walking skeleton: a real answer from a real pod, measured
      (see [docs/measurements-2026-08-30.md](docs/measurements-2026-08-30.md))
- [x] German and English throughout, including the service's own messages
- [x] App UI: pairing, overview, template editor with model picker, client tokens, settings
- [x] Tauri shell, with the device token in the OS keychain and a tray indicator
- [x] In-app help, self-checking first-run guide, generated screenshots
- [x] Scheduler, idle shutdown, wake-on-request, spend limits
- [x] Several pods at once, one per template, routed by client token
- [ ] Code signing, so the app opens without a warning

## Releases

The version lives in seven files — the root manifest, four workspaces, the Tauri
config and the Rust crate — and installers, container tags and the app's own
"about" line each read a different one. So it is never edited by hand:

```bash
node tools/bump-version.mjs patch    # 0.1.0 -> 0.1.1
node tools/bump-version.mjs minor    # 0.1.0 -> 0.2.0
node tools/bump-version.mjs major    # 0.1.0 -> 1.0.0
node tools/bump-version.mjs 1.2.3    # or say it outright
```

In practice you never run that either. **Actions → "Bump version and tag" → Run
workflow** runs the tests, moves the number, commits it and pushes the tag —
and the tag is what starts the release build. A release is still a decision, so
it is started by hand; what is automatic is the counting and the consistency.

Pushing a `v*` tag builds:

- `ghcr.io/login-tb/runpod-launcher:<version>` for amd64 and arm64
- `.dmg` for both Mac architectures and `.msi` for Windows, attached to a
  **draft** release for you to look over before publishing

## Licence

MIT
