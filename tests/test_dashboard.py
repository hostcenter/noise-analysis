#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

if "fastapi" not in sys.modules:
    try:
        import fastapi
    except ImportError:
        sys.modules["fastapi"] = MagicMock()
        sys.modules["fastapi.responses"] = MagicMock()
        sys.modules["fastapi.staticfiles"] = MagicMock()
        sys.modules["uvicorn"] = MagicMock()

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dashboard")))
import dashboard


class TestDashboardGrouping(unittest.TestCase):
    def test_group_rules(self):
        # Motor
        self.assertEqual(dashboard.group_of("Car"), "Motor")
        self.assertEqual(dashboard.group_of("Motorcycle"), "Motor")
        self.assertEqual(dashboard.group_of("Traffic noise"), "Motor")

        # Human (including animals and scream)
        self.assertEqual(dashboard.group_of("Speech"), "Human")
        self.assertEqual(dashboard.group_of("Yell"), "Human")
        self.assertEqual(dashboard.group_of("Scream"), "Human")
        self.assertEqual(dashboard.group_of("Dog"), "Human")
        self.assertEqual(dashboard.group_of("Bird"), "Human")

        # Other
        self.assertEqual(dashboard.group_of("Siren"), "Other")
        self.assertEqual(dashboard.group_of("Music"), "Other")
        self.assertEqual(dashboard.group_of("Door"), "Other")

        # Background
        self.assertEqual(dashboard.group_of("Silence"), "Background")
        self.assertEqual(dashboard.group_of("Static"), "Background")


class TestNoiseLoadCalculation(unittest.TestCase):
    def test_noise_load_ordering(self):
        # Verify that louder sounds produce higher noise load, and floor contributes 0
        con = sqlite3.connect(":memory:")
        con.executescript(dashboard.SCHEMA)

        # Insert 3 events: quiet whisper (-58 dBFS), loud car (-45 dBFS), very loud bike (-30 dBFS)
        t_base = 1791000000.0
        events = [
            (t_base, "Speech", 0.9, -58.0, 5.0, -58.0),
            (t_base + 100, "Car", 0.9, -45.0, 5.0, -45.0),
            (t_base + 200, "Motorcycle", 0.9, -30.0, 5.0, -30.0),
        ]
        con.executemany("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)", events)

        # Query noise load per event
        rows = con.execute("""
            SELECT event, ROUND(MAX(COALESCE(spl_peak, spl, -60) + 60, 0), 1)
            FROM events
            ORDER BY 2 ASC
        """).fetchall()

        # Speech at -58 -> 2.0
        # Car at -45 -> 15.0
        # Motorcycle at -30 -> 30.0
        self.assertEqual(rows[0], ("Speech", 2.0))
        self.assertEqual(rows[1], ("Car", 15.0))
        self.assertEqual(rows[2], ("Motorcycle", 30.0))
        self.assertLess(rows[0][1], rows[1][1])
        self.assertLess(rows[1][1], rows[2][1])
        con.close()


class TestDashboardIngestion(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.orig_log_dir = dashboard.LOG_DIR
        self.orig_db_path = dashboard.DB_PATH
        dashboard.LOG_DIR = self.tmp_dir.name
        dashboard.DB_PATH = os.path.join(self.tmp_dir.name, "dashboard.db")
        self.con = dashboard.connect()
        self.con.executescript(dashboard.SCHEMA)

    def tearDown(self):
        self.con.close()
        dashboard.LOG_DIR = self.orig_log_dir
        dashboard.DB_PATH = self.orig_db_path
        self.tmp_dir.cleanup()

    def test_schema_indices(self):
        indices = [r[0] for r in self.con.execute(
            "SELECT name FROM sqlite_master WHERE type='index'").fetchall()]
        self.assertIn("idx_events_ts", indices)
        self.assertIn("idx_events_event_ts", indices)
        self.assertIn("idx_events_peak", indices)

    def test_tail_file_and_events(self):
        events_path = os.path.join(self.tmp_dir.name, "events.jsonl")
        sample_event = {
            "ts": "2026-10-01T12:00:00.000Z",
            "event": "Car",
            "confidence": 0.85,
            "spl_db": -42.0,
            "spl_db_max": -38.5,
            "duration_s": 4.2,
        }
        with open(events_path, "w") as f:
            f.write(json.dumps(sample_event) + "\n")

        with patch.dict(dashboard._last_episode, {"ts": 0.0, "init": True}):
            n = dashboard.tail_file(
                self.con,
                "events.jsonl",
                "INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)",
                dashboard.event_row,
            )
            self.assertEqual(n, 1)

            row = self.con.execute(
                "SELECT event, confidence, spl, duration, spl_peak FROM events"
            ).fetchone()
            self.assertEqual(row, ("Car", 0.85, -42.0, 4.2, -38.5))


if __name__ == "__main__":
    unittest.main()
