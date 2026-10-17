#!/usr/bin/env python3
"""Cuts the normal + accent metronome clicks out of the freesound mp3.

Usage: scripts/extract_metronome.py <source.mp3>
Writes crates/core/assets/metronome_{click,accent}.wav (mono, 16-bit, 24kHz).
Source clicks: beat 1 of each 4/4 bar is the louder one (1.91s); 0.5s is a plain beat.
"""
import array, subprocess, sys, wave
from pathlib import Path

SR = 24000
PRE_MS, LEN_MS, FADE_MS = 3, 70, 15
CLIPS = {"click": 0.50, "accent": 1.91}  # approx onset seconds in the source

src = sys.argv[1]
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                     capture_output=True, check=True).stdout
a = array.array("f"); a.frombytes(raw)
out_dir = Path(__file__).resolve().parent.parent / "crates/core/assets"

for name, t in CLIPS.items():
    # snap to the real onset: first sample above 10% of the local peak
    s0 = int((t - 0.05) * SR)
    win = a[s0:s0 + int(0.15 * SR)]
    peak = max(abs(x) for x in win)
    onset = s0 + next(i for i, x in enumerate(win) if abs(x) > 0.1 * peak)
    start = onset - PRE_MS * SR // 1000
    seg = list(a[start:start + LEN_MS * SR // 1000])
    fade = FADE_MS * SR // 1000
    for i in range(fade):
        seg[-1 - i] *= i / fade
    gain = 0.95 / max(abs(x) for x in seg)
    pcm = array.array("h", (int(max(-1, min(1, x * gain)) * 32767) for x in seg))
    with wave.open(str(out_dir / f"metronome_{name}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(name, len(seg), "samples")
