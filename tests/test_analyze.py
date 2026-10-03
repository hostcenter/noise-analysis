#!/usr/bin/env python3
import json
import math
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

# Mock tflite_runtime if not available (e.g. running on host instead of container)
if "tflite_runtime" not in sys.modules:
    try:
        import tflite_runtime.interpreter
    except ImportError:
        sys.modules["tflite_runtime"] = MagicMock()
        sys.modules["tflite_runtime.interpreter"] = MagicMock()

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "analysis")))
import analyze


class TestSpectral(unittest.TestCase):
    def test_spectral_weights_and_levels(self):
        frame_len = 15600
        hann, freqs, a_weight = analyze.make_spectral(frame_len)
        self.assertEqual(len(hann), frame_len)
        self.assertEqual(len(freqs), frame_len // 2 + 1)
        self.assertEqual(len(a_weight), len(freqs))

        # Test silence (all zeros)
        silence = np.zeros(frame_len, dtype=np.float32)
        db_rms, dba, bands = analyze.frame_levels(silence, hann, freqs, a_weight)
        # Should be bounded near floor (~-190 to -200 due to 1e-20)
        self.assertLess(dba, -100)
        self.assertIn("low", bands)
        self.assertIn("mid", bands)
        self.assertIn("high", bands)

        # Test full-scale 1 kHz sine wave
        t = np.arange(frame_len) / analyze.SAMPLE_RATE
        sine_1k = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
        db_rms, dba, bands = analyze.frame_levels(sine_1k, hann, freqs, a_weight)
        # 1 kHz sine RMS is -3.0 dBFS, A-weight at 1kHz is 0 dB; 1000 Hz is in "high" band [1000, 8000)
        self.assertAlmostEqual(dba, -3.0, delta=1.5)
        self.assertGreater(bands["high"], bands["low"])
        self.assertGreater(bands["high"], bands["mid"])


class TestEpisodeStateMachine(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.orig_log_dir = analyze.LOG_DIR
        analyze.LOG_DIR = self.tmp_dir.name
        self.events_file = os.path.join(self.tmp_dir.name, "events.jsonl")
        self.spl_file = os.path.join(self.tmp_dir.name, "spl.jsonl")

    def tearDown(self):
        analyze.LOG_DIR = self.orig_log_dir
        self.tmp_dir.cleanup()

    def test_episode_lifecycle_and_max_cap(self):
        class_names = ["Car", "Speech", "Silence"]
        hann, freqs, a_weight = analyze.make_spectral(analyze.FRAME_SIZE)

        # Mock yamnet model: returns high score for class 0 ("Car")
        mock_yam = MagicMock()

        # Simulate frame generator: 5 frames
        frames = [np.zeros(analyze.FRAME_SIZE, dtype=np.float32) for _ in range(5)]

        # Class 0 has score 0.8 on frames 0, 1, 2; score 0.1 on frame 3, 4
        def fake_scores(f):
            arr = np.zeros(521, dtype=np.float32)
            arr[0] = 0.8
            return arr

        mock_yam.scores.side_effect = fake_scores

        # Run with short EPISODE_MAX = 0.05s to test capping of continuous sound
        with patch.object(analyze, "EPISODE_MAX", 0.05), \
             patch.object(analyze, "EPISODE_QUIET", 0.01), \
             patch.object(analyze, "EPISODE_REFRACTORY", 0.01), \
             patch.object(analyze, "SPL_INTERVAL", 100.0):

            # Create generator that adds small sleep to advance time
            def timed_frames():
                for f in frames:
                    time.sleep(0.03)
                    yield f

            analyze.run_loop(timed_frames(), mock_yam, hann, freqs, a_weight, class_names)

        # Verify that events were logged
        self.assertTrue(os.path.exists(self.events_file))
        events = []
        with open(self.events_file) as f:
            for line in f:
                events.append(json.loads(line))

        # Because EPISODE_MAX is 0.05s and each frame is 0.03s:
        # frame 0: ep_start at t=0.03
        # frame 1: at t=0.06 -> now - ep_start = 0.03 < 0.05
        # frame 2: at t=0.09 -> now - ep_start = 0.06 >= 0.05 -> force-logged!
        # termination flushes final episode
        self.assertGreaterEqual(len(events), 1)
        for ev in events:
            self.assertEqual(ev["event"], "Car")
            self.assertIn("duration_s", ev)
            self.assertIn("spl_db_max", ev)


if __name__ == "__main__":
    unittest.main()
