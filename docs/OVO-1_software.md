# OVO software stack

The hardware is half the product. The other half is the software that turns a 128 GB AI computer into something you
plug in and talk to within two minutes, that stays private without you having to understand why, and that makes the
sealed, water-cooled egg feel alive instead of loud.

This page covers the whole stack, from the safety microcontroller up to the apps and the business model. One piece is
already built and tested in this repo: `ovod`, the device daemon that couples the AI workload to the cooling hardware
(see [What's built](#whats-built-in-this-repo)).

## The product promise

> **Your own AI. In your home. Private by physics.**

| Promise | What makes it true |
|---|---|
| Private | Models run on the device. It works with the internet unplugged. No telemetry by default. No microphone or camera in the hardware |
| Zero-config | Plug in power and network, open the app, tap the egg twice. Models are preloaded, so the first answer comes in under 2 minutes |
| Silent | The governor runs normal chat with the fans off. You only hear it during long jobs, and only quietly (≈26 dBA in the model) |
| Open | An OpenAI-compatible API and MCP on the LAN. Any tool that talks to OpenAI can use OVO by changing one URL |
| Yours | No account needed to use it. The subscription sells convenience (remote access, backup), never data |

**Who it's for, in launch order:**
1. Privacy-sensitive professionals: law, medicine, finance, family offices. For them "it never leaves the building" is a
   compliance answer, not a feature.
2. AI power users and developers who want a big local model on the desk without a loud tower.
3. Small teams (2–20 people) sharing one box.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ CLIENTS   OVO app (iOS / macOS / Windows)   ovo.local web app (PWA)   `ovo` CLI  │
│           Any OpenAI-compatible tool (IDE, Raycast, Open WebUI…)   MCP clients   │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ HTTPS on LAN (mDNS ovo.local) · OVO Link tunnel when away
┌───────────────────────────────┴──────────────────────────────────────────────────┐
│ GATEWAY  ovo-gw      auth (passkeys, API keys) · OpenAI /v1 + MCP · fair queue    │
│                      streaming · per-user metering · tokens/s → light slit       │
├──────────────────────────────────────────────────────────────────────────────────┤
│ SERVICES  ovo-assistant  conversations, memory, tools/agents (sandboxed), jobs   │
│           ovo-index      local knowledge: connectors → chunks → hybrid search     │
│           ovo-models     catalog, signed downloads, benchmarks, hot swap          │
│           engines        llama.cpp server (main + fast models) · embeddings       │
│                          whisper.cpp (speech-to-text) · Kokoro (text-to-speech)   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ DEVICE    ovod           thermal governor · light slit · taps · power states      │
│           ovo-update     A/B OS images · model packs · MCU firmware (all signed)  │
│           ovo-backup     encrypted snapshots (USB drive or OVO+ cloud)            │
├──────────────────────────────────────────────────────────────────────────────────┤
│ OS        Immutable Linux image (bootc) · current kernel + Mesa + ROCm for gfx1151│
│           Secure Boot · TPM2-sealed disk encryption · nftables · systemd          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ FIRMWARE  Controller MCU (Rust/Embassy): fans, pump, flow, leak, thermistors,     │
│           accelerometer, light slit, PSU enable. Safety does not need the host    │
├──────────────────────────────────────────────────────────────────────────────────┤
│ HARDWARE  Strix Halo 128 GB · water-jacketed shell · belly radiator · keel ports  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Layer by layer

### 1. Controller firmware

- **MCU.** RP2040 or STM32G0 class, on the controller PCB (BOM item OVO1-501), connected to the host over USB CDC.
- **Language.** Rust on Embassy. The safety logic is small, and memory safety is worth it here.
- **Owns:**
  - 2 fan PWMs and tachs
  - pump PWM and the flow sensor
  - water-in and water-out thermistors
  - the intake-air thermistor
  - the leak sensor
  - the accelerometer (taps, lift detection)
  - the RGBW light slit
  - the PSU enable line
- **Safety rules run on the MCU, independent of Linux.** Leak or water ≥ 55 °C cuts power and latches. A lost host
  heartbeat (5 s) means full cooling. No flow for 3 s means fans at 100%. The pump never runs below 30%.
- **Reference model.** The rules are written once, in `software/ovod/protocol.py` (`McuSafety`). The firmware test
  suite replays the same cases, so Python and Rust can't drift apart.
- **Protocol.** Newline-delimited JSON, ≤ 256 bytes per line. It's slow by MCU standards, but trivially debuggable
  with `screen`, and 1 Hz control doesn't need more.

### 2. Operating system

- **Image-based.** Fedora-based **bootc** (OSTree) image, built from a Containerfile in CI.
  - Updates are atomic: A/B with automatic rollback if health checks fail after a reboot.
  - Nobody (us included) hand-patches devices in the field.
- **Why not Ubuntu Core or plain Debian?** Strix Halo's GPU (gfx1151) needs a current kernel, Mesa and ROCm. Fedora
  tracks them closely. Snaps and Debian stable lag behind.
- **Unified memory.** Linux lets the GPU address most of the 128 GB through GTT. Set the kernel parameters
  (`amdgpu`/`ttm` page limits) so ~110 GB is usable by models. Verify against the chosen board's BIOS.
- **Security baseline:**
  - Secure Boot with our keys; the root filesystem is read-only
  - LUKS2 data partition sealed to TPM2 (measured boot)
  - nftables allows only the gateway's ports on the LAN
  - no SSH by default (a developer mode exists, and enabling it requires physical taps on the shell)

### 3. Inference engines

**Primary: llama.cpp `llama-server`.**
- runs GGUF models, with every quantization level
- excellent mixture-of-experts support (the sweet spot for 128 GB)
- speculative decoding
- parallel slots for several users
- an OpenAI-compatible server already built in

Backends: **Vulkan** by default, the most robust on RDNA 3.5 today. **ROCm/HIP** where it benchmarks faster. Each model
pack ships with the backend that won *on this device* (`ovo-models` benchmarks at install).

**Later: vLLM**, for teams, once its ROCm support on gfx1151 matures. It batches many users better.

**Memory plan (default pack)** fits in the ~110 GB GPU budget with room to spare:

| Role | Model (Apache-2.0 / permissive) | ≈ GB |
|---|---|---|
| Main brain | gpt-oss-120b (MoE, MXFP4) | 61 |
| KV cache, 2 parallel slots, long context | — | 8–16 |
| Fast model: routing, titles, autocomplete, draft for speculative decoding | Qwen3-4B (Q4) | 3 |
| Embeddings (knowledge search) | Qwen3-Embedding-0.6B | 1.2 |
| Speech to text | whisper large-v3-turbo | 1.6 |
| Text to speech | Kokoro-82M | 0.3 |
| **Total** | | **≈ 75–83** |

Swappable packs: "Writer" (dense 32B for prose), "Coder" (coding MoE), "Max" (largest model that fits). Only models with
licenses that allow commercial redistribution go into the preloaded pack.

### 4. Model manager: `ovo-models`

- **Catalog.** A signed JSON manifest per model: source, license, sha256, size, quantization, context length,
  capabilities (tools, vision), and recommended engine flags.
- **Downloads.** Resumable HTTPS. The hash is verified before a model is enabled. Licenses are shown and accepted in the
  app. Nothing executes from a model file except weights.
- **Install benchmark.** After install, a 60 s benchmark measures tokens/s per backend and stores the result. That
  number drives the app's "speed" badge and the light slit's scale.
- **Hot swap.** Change the main model without a reboot. The gateway drains in-flight requests first.

### 5. Gateway: `ovo-gw`

The only process listening on the network. One static binary (**Rust + axum**), because it holds the auth and parses
untrusted input.

- **APIs:**

  | API | Endpoints |
  |---|---|
  | OpenAI-compatible | `/v1/chat/completions` (streaming, tools), `/v1/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/models` |
  | MCP | streamable-HTTP endpoint exposing the device's tools (knowledge search, files, jobs) to MCP clients |
  | OVO | `/ovo/v1/...`: device status, thermal state, burst budget, pairing, users, models, jobs |

- **Auth:**
  - passkeys (WebAuthn) for people in the app or web UI
  - scoped API keys for tools (for example "chat only", or "knowledge: read")
  - every key is revocable, and every use goes into a local audit log
- **Scheduler.** A fair queue in front of the engine's slots. Interactive requests beat background jobs, with
  per-user fairness so one agent can't starve the household. Cancellation works mid-stream.
- **Metering.** It counts tokens/s per request and sends it to `ovod`, which sets the light slit's brightness. Usage
  stats stay on the device.

### 6. Assistant runtime: `ovo-assistant`

**Python**, because that's where the agent and tooling ecosystem lives. It runs behind the gateway, never exposed.

- **Conversations and memory.** Memory is opt-in and user-visible: OVO proposes "remember that…" and you approve it.
  Memories are stored per user and can be edited and deleted.
- **Tools via MCP.** Built-in tools: knowledge search, web fetch (off by default), calculator/code runner, calendar,
  mail drafts. Third-party MCP servers can be installed from the app.
- **Sandboxing.** Each tool runs in a bubblewrap/container sandbox with no network and no filesystem unless granted.
  Permissions are per tool, granted in the app, and shown in the audit log.
- **Prompt-injection posture.** Content from documents, mail and the web is marked untrusted. Tools with side effects
  (send mail, delete files) always need a tap-to-approve in the app.
- **Background jobs.** Summarise the inbox at 07:00, re-index overnight. Jobs are **thermal-aware**: the scheduler
  asks `ovod` for the burst budget and runs heavy jobs when the egg is cold or when nobody is around to hear the fans.

### 7. Knowledge: `ovo-index`

- **Connectors** (all local, tokens stored on the device):
  - an "OVO Drop" SMB/AFP share: drag files onto the egg from any computer
  - folders on the LAN
  - IMAP mail and CalDAV
  - optional Google Drive, Notion and SharePoint sync for teams
- **Pipeline.** Parse (PDF, Office, mail, images with OCR) → chunk → embed → store.
- **Search.** SQLite with FTS5 (keywords) plus sqlite-vec (vectors), fused into one hybrid ranking. One file per user,
  so it's easy to back up and easy to delete.
- **Answers cite their sources** (document, page). Permissions follow the source: a team member can't retrieve a folder
  they weren't shared.

### 8. Device daemon: `ovod` (built, see below)

- **1 Hz governor.** Chooses fan speed, pump speed and the SoC power cap from water temperature, die temperature,
  flow, the leak sensor and the user's mode (Silent / Auto / Performance).
- **Burst budget.** The water and metal store ~4.7 kJ/K. `ovod` turns the remaining headroom into seconds, for the UI
  ("silent at full power for 9 more min") and for the job scheduler.
- **Light slit.** Patterns for thinking, generating (brightness follows tokens/s), pairing, attention and fault.
  Capped at 15% in night mode.
- **Gestures.** Tap ×2 is pause/resume (or show the status in the app). Tap ×3 is pairing or presence proof.
  Lifting the egg locks the device.
- **SoC power cap.** Applied through the platform power-limit interface (verify the exact knob on the chosen board).

### 9. Updates, backup, remote access

- **`ovo-update`.** Three independent signed channels:
  - OS image (A/B, monthly, plus security fixes)
  - model packs
  - MCU firmware (dual-bank, rolls back on a failed boot)

  The gateway shows what changed. Updates install at night, when the burst budget is full.
- **`ovo-backup`.** An age-encrypted snapshot of conversations, memory, the index and settings. The key comes from the
  owner's recovery phrase. The destination is a USB drive on the keel, or **OVO+ cloud**, which is zero-knowledge (we
  store ciphertext).
- **OVO Link (remote access).** A WireGuard tunnel through our relay. Keys live on the device and your phone, so the
  relay only sees encrypted packets. Power users can use their own Tailscale/WireGuard instead and skip the relay.

### 10. Apps

| Client | Tech | Why |
|---|---|---|
| Web app at `ovo.local` | TypeScript + React, PWA, served by the device | Works on any device on day one. Setup, chat, knowledge, settings |
| iOS / macOS | Swift / SwiftUI | Share sheet ("Ask OVO"), widgets showing status and the burst budget, the phone's microphone for voice, push via OVO Link |
| Windows | WinUI or a wrapped web app | Phase 2 |
| `ovo` CLI | Single binary | Scripting, pipes (`cat report.pdf \| ovo ask "summarise"`), dev mode |
| Everything else | OpenAI-compatible URL | IDEs, Raycast, Open WebUI and friends work unchanged |

**Setup flow (target under 2 minutes to the first answer):**

1. Plug in power and Ethernet. Or plug USB-C into a laptop, and the egg appears as a network device.
2. The light slit breathes slowly: ready.
3. Open the app or `ovo.local`. It finds the egg over mDNS.
4. "Tap the egg twice." The accelerometer proves you are physically there, so nobody else on the Wi-Fi can claim it.
5. Create the owner passkey and save the recovery phrase.
6. The preloaded model pack is already on the SSD. Ask the first question.

## Security model

| Threat | Defence |
|---|---|
| Someone else on the LAN | No anonymous access. Pairing needs physical taps. Passkeys and scoped keys; TLS with a device certificate pinned at pairing |
| A malicious or compromised tool / MCP server | Sandbox with no network or files unless granted; side-effecting actions need approval; audit log |
| Prompt injection from documents, mail, web | Untrusted-content marking; approval gate on side effects; no tool can raise its own permissions |
| Stolen device | TPM-sealed disk plus per-user data keys wrapped by the passkey (open decision: this costs "unattended reboot keeps serving") |
| Supply chain (models, updates) | Signed manifests and images, hash-verified models, reproducible OS builds, SBOM per release |
| Us | No telemetry by default. Opt-in crash reports are scrubbed and shown before sending. OVO+ backups are zero-knowledge. The relay sees only ciphertext |

## Business model

| Tier | Price (draft) | What |
|---|---|---|
| **OVO** | Included with the device | Everything local: models, apps, API, knowledge, updates for 5 years |
| **OVO+** | ~$12 / month | OVO Link remote access, zero-knowledge cloud backup, early model packs, priority support |
| **OVO Teams** | ~$15 / seat / month | Multi-user admin, SSO, per-folder permissions, exportable audit log, fleet updates, compliance pack (data-flow documentation for regulators) |

At ~$2.5k BOM, the device should retail at ~$4.5–5k. Software is the moat, and the reason a team buys a second box.

## Roadmap

| Phase | When | Software | Hardware |
|---|---|---|---|
| 0: dev kit | M0–M2 | OS image; llama.cpp benchmarks on Strix Halo; gateway MVP; web app chat; ovod against the thermal model (**done**) | Off-the-shelf Strix Halo board in an open frame |
| 1: EVT | M3–M6 | MCU firmware against the reference model; calibrate the plant model on real thermocouples; knowledge v1; setup flow; iOS app | First water-jacketed shells |
| 2: DVT | M6–M9 | OTA, backup, OVO Link; external security audit; 50-user beta | Tooling, leak testing |
| 3: PVT and launch | M9–M12 | Teams tier; Windows; documentation | FCC/CE, IEC 62368-1, launch |

**Team (minimum):**
- 1 embedded/firmware
- 1 Linux/platform
- 1 inference/performance
- 2 backend (gateway, assistant, index)
- 2 apps (web, Apple)
- 1 product designer (shared with industrial design)

## Risks and open decisions

1. **ROCm maturity on gfx1151.** Mitigation: Vulkan is the default backend, and per-model benchmarks pick the winner.
   Don't promise vLLM until it is proven.
2. **Model licensing.** Preload only Apache-2.0/MIT-class models. Licenses with redistribution or user-count clauses
   become user downloads with the license shown.
3. **The competition is commoditising the compute.** DGX Spark, Mac Studio and the Framework Desktop with Ollama all
   exist. The defensible part is the *whole* experience: the object, zero-config, silence, privacy by default, and team
   features. Put engineering there, not into a faster engine.
4. **Stolen-device data protection versus unattended operation** (see Security model). This needs a product decision.
5. **Thermal model calibration.** Every number in `ovod.plant` marked ASSUMPTION must be measured on EVT hardware. The
   governor gains will move.

## What's built in this repo

`software/ovod/` is a pure-Python prototype with no dependencies:

| Module | Purpose |
|---|---|
| `plant.py` | Lumped thermal model of the OVO-1 hardware (constants from `docs/OVO-1.md`) |
| `governor.py` | The 1 Hz cooling and power governor: Silent / Auto / Performance, safety trips, burst budget |
| `light.py` | Light-slit patterns |
| `protocol.py` | Host–MCU line protocol, plus `McuSafety`, the reference model for the firmware's safety rules |
| `sim.py` | Scenario runner |

```
cd software
python3 -m unittest -v          # 27 tests: safety rules, protocol, light, and the product promises below
python3 -m ovod.sim             # scenario table (add --ambient 32 for a hot room)
```

**Simulated results, 25 °C room.** The model has stated assumptions; these are not measurements.

| Scenario | Mode | Skin max | Fans on | Loudest | Speed |
|---|---|---|---|---|---|
| Chat, 60 min (question every 2 min) | Auto | 39.2 °C | 0% | silent | 100% |
| Long job, 60 min, back-to-back | Silent | 43.5 °C | 0% | silent | 53% |
| Long job, 60 min | Auto | 42.7 °C | 79% | ~26 dBA | 100% |
| Long job, 60 min | Performance | 37.4 °C | 89% | ~34 dBA | 100% |
| Pump fails at 10 min | Any | ≤ 38.1 °C | yes | ~34 dBA | 70% (die held ≤ 100 °C) |

Full-power generation from cold runs **~13 min before the fans start** at 25 °C, and ~7 min at 32 °C.

**What the simulation changed in the design:**

- **Silent mode needed a lower power floor.** At a 30 W cap the board still made more heat than the sealed skin can
  shed, and the safety trip started the fans. Silent mode can now cap the SoC at 15 W and starts trimming 2 K early.
- **In a 32 °C room, Silent can't stay silent on a back-to-back job.** Physics wins and the safety trip starts the fans.
  The app should say so honestly, or offer to pause the job instead.
