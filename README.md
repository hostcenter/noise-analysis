# Environmental Noise Analysis — Raspberry Pi

Continuous monitoring of city sounds outside a window (cars, motorbikes,
leaf blowers, music, people talking/passing by), with event detection,
SPL logging, and optional LLM-generated daily summaries.

## Why this exists

Answer "what was that noise, and how often/when does it happen?" with data
instead of guessing. The goal is not recording — it's understanding which
noise sources occur, when, how loud, and how frequent, over days/weeks.
Fully offline: no cloud, no raw audio stored or transmitted; only derived
events and levels (privacy).

## Hardware

| Component | Details |
|---|---|
| Machine | Raspberry Pi, Debian 13 (trixie), ARM64, kernel `6.18.39+rpt-rpi-v8` |
| CPU / RAM | 4 cores, 7.6 GiB RAM, ~48 GiB free on SD card |
| Microphone | Delock condenser omnidirectional mic (USB), plugged in and live (ALSA card `M20672`) |
| Pi audio out | 2× HDMI playback only (`/dev/snd` has no capture device yet) |

## Architecture

```
Delock mic (USB) ── ALSA capture (16 kHz mono, via Docker device mount)
      │
      ▼
Analysis container  (python + numpy + tflite-runtime)
  ├─ SPL meter: dB(A) estimate from RMS, A-weighted spectrum
  ├─ YAMNet (TFLite, AudioSet 521 classes) → sound event detection
  │    classes of interest: car, motorcycle, leaf blower, music, speech...
  └─ JSONL event log: {ts, event, confidence, spl_dba, band levels}
      │
      ▼
logs/events.jsonl  (one JSON object per line, logrotate-friendly)
      │
      ├──► Dashboard container (FastAPI + SQLite index + ECharts UI, :8080)
      └──► Ollama container (small LLM) → daily human-readable summaries
```

## Key decisions

- **YAMNet** for sound event detection — NOT an LLM. LLMs can't classify
  audio in real time; AudioSet-trained classifiers have exactly the right
  classes (car, motorcycle, leaf blower, music, speech, chatter).
- **YAMNet over PANNs** — YAMNet is TFLite + real-time capable on a Pi;
  PANNs CNN14 is more accurate but too heavy without quantization.
- **JSONL** logging (not SQLite) — one JSON event per line, easy to
  stream/rotate; dashboards can tail it.
- **Ollama is a summarizer, not a detector** — it only reads the JSONL log
  and produces natural-language daily summaries.
- **Everything runs in containers** (analysis + Ollama).

## Current status

- [x] Docker installed (v29.7.2 via get.docker.com), user `raul` added to
      `docker` group (**re-login required for group to take effect** — until
      then use `sg docker -c "<cmd>"`)
- [x] YAMNet TFLite model downloaded — **tfhub.dev is dead (403)**; got the
      original artifact from HF mirror
      `niobures/YAMNet` → `yamnet/lite-model_yamnet_classification_tflite_1.tflite`
      (input is 1-D float32 `[15600]`, handled rank-agnostically in code)
- [x] Analysis script + analyzer image (`analysis/`)
- [x] docker-compose.yml: analyzer + ollama + summarizer
- [x] Ollama running with `llama3.2:3b` pulled (2.0 GB)
- [x] Summarizer service + smoke test passed (writes
      `logs/summaries/summary-<date>.md` + `logs/summaries.jsonl`)
- [x] Analyzer smoke test passed with synthetic WAV: events + SPL JSONL
      correct (synthetic noise → "White noise" 0.89; tone → "Whistle")
- [x] **Mic plugged in and LIVE**: Delock 20672 (JMTek 0c76:0072), ALSA card
      `M20672`. Verified: real-time SPL + YAMNet events flowing (~2 % CPU).
      Device is set in `.env` → `ALSA_DEVICE=plughw:CARD=M20672,DEV=0`
      (`default` does not work in the container: no capture slave).
      NOTE: plugging a device after container start requires
      `docker compose restart analyzer` to be seen.
- [x] **Dashboard live**: `dashboard/` service (FastAPI + SQLite WAL index +
      vendored ECharts/ECharts-GL, no CDN — fully offline) on `127.0.0.1:8080`.
      Tails JSONL → `logs/dashboard.db` (offset/inode-tracked, survives
      restarts & logrotate). Left-nav views (all counting EPISODES):
      Readme (in-app guide), Last 5 min (live strip, pills on the line,
      light background bands by loudness range), Loudness (30d) (groups ×
      1 dB buckets, stacked blue/yellow/red by band), 3D (7d) (dot cloud:
      hour × weekday × avg loudness), Weekday (4w) (nested green/yellow/red
      cells, weekday-averaged), Loudest (3w) + Longest (3w) (full episode
      tables, night rows tinted). Sidebar filters: 22-06h toggle (night
      hours only) and a "Louder than" threshold affecting the 3D color
      split and the Weekday grids. Classes are grouped city-relevant
      (Human incl. animals, Motor, Music, Other); a configurable blocklist
      (`EVENT_BLOCKLIST`) never logs impossible / noise-floor classes
      (livestock, owls, whales, artillery, Silence, White noise, …).
      Verified end-to-end: all `/api/*` endpoints + static assets 200.

## Layout

```
analysis/    analyze.py + Dockerfile (capture → SPL + YAMNet → JSONL)
summarizer/  summarize.py + Dockerfile (JSONL → Ollama → daily .md)
dashboard/   dashboard.py + static/ + Dockerfile (JSONL → SQLite → web UI)
models/      yamnet.tflite + yamnet_class_map.csv (521 classes)
logs/        spl.jsonl, events.jsonl, summaries/, dashboard.db
             (bind-mounted to /data/logs; dashboard.db is a derived,
             disposable index — delete it any time, it rebuilds from JSONL)
```

## Running

```bash
cd ~/noise-analysis
docker compose up -d        # all four services
docker compose logs -f analyzer

# Dashboard: http://localhost:8080 (localhost only; expose via cloudflared
# or SSH forward if needed). Views: Last 5 min (live), Loudness (30d),
# 3D (7d), Weekday (4w), Loudest (3w), Longest (3w), Readme (in-app guide).
# Sidebar filters: 22-06h (night hours only) + "Louder than" threshold.

# Smoke test without mic (file mode):
# generate a 16 kHz mono 16-bit WAV into logs/, then:
docker compose run --rm -e SOURCE=file -e INPUT_FILE=/data/logs/test.wav analyzer
rm logs/test.wav            # privacy: never keep audio files

# Manual summary for a day:
docker compose run --rm -e RUN_ONCE=1 -e SUMMARY_DATE=2026-09-01 summarizer

# Ollama directly:
docker exec noise-ollama ollama run llama3.2:3b
```

## Log formats

- `spl.jsonl` (1/s): `{"ts", "spl_db", "spl_db_min", "spl_db_max",
  "bands": {"low","mid","high"}}` — dBFS(A), uncalibrated
- `events.jsonl` (episodes only: one record per acoustic episode, written
  when the episode ends after `EPISODE_QUIET` 2 s of quiet — type/conf/SPL
  from its loudest moment, `duration_s` = how long it lasted, capped by
  `EPISODE_MAX` 120 s; new episodes start ≥ `EPISODE_REFRACTORY` 10 s after
  the previous one; nested AudioSet categories and blocklisted classes are
  skipped): `{"ts", "event", "confidence", "spl_db", "duration_s"}`
- `summaries/summary-<date>.md` + `summaries.jsonl` (daily, 07:00 UTC by
  default; UTC day boundaries; skipped if no data)

Tuning via `.env` (copy from `.env.example`): `EVENT_THRESHOLD`,
`EVENT_REFRACTORY`, `EVENT_BLOCKLIST` (`;`-separated AudioSet class names the
analyzer never logs and the dashboard never indexes — used to silence
false positives that are impossible in central Zurich: livestock, poultry,
owls, whales, artillery, office sounds, Silence, White noise, …),
`EPISODE_REFRACTORY` (min gap between episodes), `EPISODE_QUIET` (silence
that ends an episode), `EPISODE_MAX` (force-log cap), `SPL_INTERVAL`,
`ALSA_DEVICE` (use `plughw:CARD=<n>,DEV=0` if `default` picks wrong device),
`OLLAMA_MODEL`, `SUMMARY_HOUR`, `TZ` (also drives the dashboard heatmap's
hour-of-day), `DASH_INGEST_INTERVAL`.

## Useful commands / notes

```bash
# After plugging the mic: verify it appears
arecord -l

# Quick mic test (adjust card/device numbers from arecord -l)
arecord -D plughw:<card>,<device> -f S16_LE -r 16000 -c 1 -d 5 test.wav

# Docker (new login needed after group add)
newgrp docker   # or log out/in
```

- Model: YAMNet TFLite from tfhub
  (`lite-model/yamnet/classification/tflite/1`) or
  tensorflow/models GitHub (`yamnet.tflite` + `yamnet_class_map.csv`).
- YAMNet input: 16 kHz mono float32, 0.96 s frames (0.48 s hop).
- A-weighting: apply FFT weights for a decent SPL estimate; the mic is not
  calibrated, so treat dB values as relative until calibrated against a
  reference SPL meter.
- Ollama ARM64 image: `ollama/ollama`; small models that fit in 8 GiB RAM
  alongside the analyzer: `llama3.2:3b` or `qwen2.5:3b` (run one at a time,
  the classifier is light but the Pi only has 8 GiB).
