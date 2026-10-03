#!/usr/bin/env python3
"""Real-time environmental sound analysis.

Captures 16 kHz mono audio from ALSA (or a WAV file for testing), computes
A-weighted SPL and band levels, runs YAMNet (TFLite) sound event detection,
and logs results as JSONL: spl.jsonl (1/s aggregates) and events.jsonl
(event onsets, refractory-limited).
"""

import csv
import json
import math
import os
import signal
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone

import numpy as np
import tflite_runtime.interpreter as tflite

SAMPLE_RATE = 16000
FRAME_SIZE = int(os.environ.get("FRAME_SIZE", "15600"))
HOP_SIZE = int(os.environ.get("HOP_SIZE", "0")) or FRAME_SIZE
EVENT_THRESHOLD = float(os.environ.get("EVENT_THRESHOLD", "0.3"))
EVENT_REFRACTORY = float(os.environ.get("EVENT_REFRACTORY", "10.0"))
# episodes: one acoustic episode (e.g. one car pass) = ONE logged event; the
# strongest class above threshold wins, all other simultaneous detections
# (nested AudioSet categories) are skipped
EPISODE_REFRACTORY = float(os.environ.get("EPISODE_REFRACTORY", "10.0"))
EPISODE_QUIET = float(os.environ.get("EPISODE_QUIET", "2.0"))   # silence that ends an episode
EPISODE_MAX = float(os.environ.get("EPISODE_MAX", "120.0"))     # force-log cap
# classes to never log (impossible at this location); separator is ";" because
# AudioSet display names can contain commas ("Cattle, bovinae")
EVENT_BLOCKLIST = {
    s.strip() for s in os.environ.get("EVENT_BLOCKLIST", "").split(";") if s.strip()
}
SPL_INTERVAL = float(os.environ.get("SPL_INTERVAL", "1.0"))
LOG_DIR = os.environ.get("LOG_DIR", "/data/logs")
MODEL_PATH = os.environ.get("MODEL_PATH", "/app/models/yamnet.tflite")
CLASS_MAP_PATH = os.environ.get("CLASS_MAP_PATH", "/app/models/yamnet_class_map.csv")
SOURCE = os.environ.get("SOURCE", "alsa")
ALSA_DEVICE = os.environ.get("ALSA_DEVICE", "default")
INPUT_FILE = os.environ.get("INPUT_FILE", "")
RUN_SECONDS = float(os.environ.get("RUN_SECONDS", "0"))
RETRY_DELAY = float(os.environ.get("RETRY_DELAY", "30"))

BANDS = [("low", 63.0, 250.0), ("mid", 250.0, 1000.0), ("high", 1000.0, 8000.0)]
HANN_MEAN_SQ = 0.375

_stop = False


def _on_term(signum, frame):
    global _stop
    _stop = True


def iso_now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def append_json(name, obj):
    path = os.path.join(LOG_DIR, name)
    with open(path, "a") as f:
        f.write(json.dumps(obj, separators=(",", ":")) + "\n")


def load_class_names(path):
    with open(path, newline="") as f:
        return [row["display_name"] for row in csv.DictReader(f)]


class Yamnet:
    def __init__(self, model_path, num_classes):
        self.interpreter = tflite.Interpreter(model_path=model_path)
        self.interpreter.allocate_tensors()
        inp = self.interpreter.get_input_details()[0]
        shape = list(inp["shape"])
        sig = inp.get("shape_signature")
        self.rank = len(shape)
        self.frame_len = int(shape[-1])
        dynamic = sig is not None and int(sig[-1]) == -1
        if self.frame_len <= 1 or dynamic:
            target = [1, FRAME_SIZE] if self.rank >= 2 else [FRAME_SIZE]
            self.interpreter.resize_tensor_input(inp["index"], target, strict=True)
            self.interpreter.allocate_tensors()
            inp = self.interpreter.get_input_details()[0]
            self.frame_len = int(inp["shape"][-1])
        outs = self.interpreter.get_output_details()
        self.scores_idx = next(
            o["index"] for o in outs if list(o["shape"])[-1] == 521
        )
        self.in_idx = inp["index"]

    def scores(self, wav):
        arr = wav.astype(np.float32)
        arr = arr.reshape(1, -1) if self.rank >= 2 else arr.reshape(-1)
        self.interpreter.set_tensor(self.in_idx, arr)
        self.interpreter.invoke()
        s = self.interpreter.get_tensor(self.scores_idx)
        return s.max(axis=0)


def make_spectral(frame_len):
    hann = np.hanning(frame_len)
    freqs = np.fft.rfftfreq(frame_len, 1.0 / SAMPLE_RATE)
    f2 = freqs.astype(np.float64) ** 2
    ra = (12194.0**2 * f2**2) / (
        (f2 + 20.6**2)
        * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2))
        * (f2 + 12194.0**2)
    )
    a_weight = 10.0 ** ((20.0 * np.log10(np.maximum(ra, 1e-12)) + 2.0) / 10.0)
    return hann, freqs, a_weight


def frame_levels(x, hann, freqs, a_weight):
    p = np.abs(np.fft.rfft(x * hann)) ** 2

    def rms2(w):
        s = 2.0 * float(np.dot(p[1:-1], w[1:-1])) + p[0] * w[0] + p[-1] * w[-1]
        return s / (len(x) * len(x) * HANN_MEAN_SQ)

    db_rms = 10.0 * math.log10(rms2(np.ones_like(a_weight)) + 1e-20)
    dba = 10.0 * math.log10(rms2(a_weight) + 1e-20)
    bands = {}
    for name, lo, hi in BANDS:
        m = (freqs >= lo) & (freqs < hi)
        bands[name] = round(10.0 * math.log10(rms2(np.where(m, a_weight, 0.0)) + 1e-20), 1)
    return round(db_rms, 1), round(dba, 1), bands


def alsa_frames():
    cmd = [
        "arecord", "-D", ALSA_DEVICE, "-f", "S16_LE",
        "-r", str(SAMPLE_RATE), "-c", "1", "-t", "raw", "-q",
        "--buffer-time", "1000000",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        buf = np.zeros(0, dtype=np.float32)
        need = HOP_SIZE * 2
        while not _stop:
            raw = proc.stdout.read(need)
            if not raw:
                err = proc.stderr.read().decode("utf-8", errors="replace").strip()
                if err:
                    print(f"arecord error: {err}", flush=True)
                break
            chunk = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            buf = np.concatenate([buf, chunk])
            while len(buf) >= FRAME_SIZE:
                yield buf[:FRAME_SIZE]
                buf = buf[HOP_SIZE:]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()


def file_frames(path):
    with wave.open(path, "rb") as w:
        sr, ch, width, n = (
            w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        )
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"unsupported sample width: {width} bytes (need 16-bit PCM)")
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch)[:, 0]
    if sr != SAMPLE_RATE:
        n_new = int(len(data) * SAMPLE_RATE / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n_new), np.arange(len(data)), data)
    print(f"file: {path} sr={sr} ch={ch} dur={len(data)/SAMPLE_RATE:.1f}s", flush=True)
    for i in range(0, len(data) - FRAME_SIZE + 1, HOP_SIZE):
        if _stop:
            return
        yield data[i : i + FRAME_SIZE]


def _emit_episode(start_ts, best, peak, last_loud, class_names):
    bi, bconf, bspl = best
    append_json(
        "events.jsonl",
        {
            "ts": datetime.fromtimestamp(start_ts, timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "event": class_names[int(bi)],
            "confidence": round(bconf, 3),
            "spl_db": bspl,
            "spl_db_max": round(peak, 1),
            "duration_s": round(max(0.0, last_loud - start_ts), 1),
        },
    )


def run_loop(frames, yam, hann, freqs, a_weight, class_names):
    last_logged = {}
    last_spl = time.time()
    last_event = 0.0
    ep_start = None      # episode in progress: start ts
    ep_best = None       # (class idx, confidence, spl) at the loudest moment
    ep_peak = None       # strict max frame SPL over the whole episode
    ep_last_loud = None  # last ts with a loud frame
    spl_vals = []
    bands = {}
    start = time.time()
    for frame in frames:
        _, dba, bands = frame_levels(frame, hann, freqs, a_weight)
        spl_vals.append(dba)
        now = time.time()
        if SOURCE == "file" or now - last_spl >= SPL_INTERVAL:
            append_json(
                "spl.jsonl",
                {
                    "ts": iso_now(),
                    "spl_db": round(sum(spl_vals) / len(spl_vals), 1),
                    "spl_db_min": round(min(spl_vals), 1),
                    "spl_db_max": round(max(spl_vals), 1),
                    "bands": bands,
                },
            )
            last_spl = now
            spl_vals = []
        scores = yam.scores(frame)
        top = np.argsort(scores)[::-1]
        # strongest non-blocklisted class above threshold in this frame
        best = None
        for i in top[:10]:
            if scores[i] < EVENT_THRESHOLD:
                break
            if class_names[int(i)] in EVENT_BLOCKLIST:
                continue
            best = i
            break
        if best is not None:
            # episode continues (or starts a new one after the refractory)
            if ep_start is None:
                if now - last_event >= EPISODE_REFRACTORY:
                    ep_start = now
                    ep_best = (best, float(scores[best]), dba)
                    ep_peak = dba
                    ep_last_loud = now
            else:
                ep_last_loud = now
                if scores[best] > ep_best[1]:
                    ep_best = (best, float(scores[best]), dba)
            if ep_start is not None:
                ep_peak = max(ep_peak, dba)
                # cap: force-log episodes that exceed EPISODE_MAX without going quiet
                if now - ep_start >= EPISODE_MAX:
                    _emit_episode(ep_start, ep_best, ep_peak, now, class_names)
                    last_event = now
                    last_logged[ep_best[0]] = now
                    ep_start = now
                    ep_best = (best, float(scores[best]), dba)
                    ep_peak = dba
                    ep_last_loud = now
        elif ep_start is not None and now - ep_last_loud >= EPISODE_QUIET:
            # episode over (quiet for EPISODE_QUIET seconds) → write it with
            # its duration; ts = episode start, type/conf/spl at the loudest,
            # spl_db_max = strict peak level over all episode frames
            last_event = ep_last_loud
            last_logged[ep_best[0]] = ep_start
            _emit_episode(ep_start, ep_best, ep_peak, ep_last_loud, class_names)
            ep_start = None
            ep_best = None
            ep_peak = None
            ep_last_loud = None
        if RUN_SECONDS > 0 and time.time() - start >= RUN_SECONDS:
            break

    if ep_start is not None and ep_best is not None:
        _emit_episode(ep_start, ep_best, ep_peak, ep_last_loud or ep_start, class_names)


def main():
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    os.makedirs(LOG_DIR, exist_ok=True)

    class_names = load_class_names(CLASS_MAP_PATH)
    yam = Yamnet(MODEL_PATH, 521)
    global FRAME_SIZE, HOP_SIZE
    if yam.frame_len > 1:
        FRAME_SIZE = yam.frame_len
        HOP_SIZE = min(HOP_SIZE if HOP_SIZE > 0 else FRAME_SIZE, FRAME_SIZE)
    HOP_SIZE = max(1, HOP_SIZE)
    hann, freqs, a_weight = make_spectral(FRAME_SIZE)
    print(
        f"yamnet ready: frame={FRAME_SIZE} hop={HOP_SIZE} "
        f"classes={len(class_names)} threshold={EVENT_THRESHOLD}",
        flush=True,
    )

    if SOURCE == "file":
        if not INPUT_FILE:
            raise SystemExit("SOURCE=file requires INPUT_FILE")
        run_loop(file_frames(INPUT_FILE), yam, hann, freqs, a_weight, class_names)
        print("file analysis done", flush=True)
        return

    while not _stop:
        try:
            print(f"capture start: {ALSA_DEVICE}", flush=True)
            run_loop(alsa_frames(), yam, hann, freqs, a_weight, class_names)
            if _stop:
                break
            print(f"capture ended, retrying in {RETRY_DELAY}s", flush=True)
            time.sleep(RETRY_DELAY)
        except Exception as exc:
            print(f"capture error: {exc!r}, retrying in {RETRY_DELAY}s", flush=True)
            time.sleep(RETRY_DELAY)
    print("stopped", flush=True)


if __name__ == "__main__":
    main()
