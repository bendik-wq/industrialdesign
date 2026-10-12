#!/usr/bin/env python3
"""Turn recordings of Josh into a clean training set for an ElevenLabs Professional Voice Clone.

Usage:  python3 prepare.py <input folder> <output folder> [--minutes 120]

Input: original video or audio files of Josh talking on his own (mp4, mov, m4a, mp3, wav, webm, ...). Use solo
talking videos: no interviews, podcasts with guests, cold-call recordings or vlogs, so no other voice gets in.
Original exports from the editor beat YouTube downloads (no re-compression).

What it does, with ffmpeg only:
  1. Mono, 44.1 kHz, 16-bit; a 70 Hz high-pass for rumble and desk thumps.
  2. Trims the first and last 8 seconds of each file (intro and outro music, "subscribe" cards).
  3. Finds long silences (silencedetect) and cuts them out, keeping natural pauses under 1.2 s so the clone
     learns Josh's real rhythm. Music under his voice isn't removed: pick videos without background music, or
     run the clips through ElevenLabs' voice isolator first.
  4. Loudness-normalises every clip to -18 LUFS (ElevenLabs' recommended -23 to -18 range), peaks under -3 dB.
  5. Writes 3-6 minute clips (ElevenLabs takes files of any length; this size uploads reliably), up to
     --minutes in total (ElevenLabs recommends 30 minutes to 3 hours; 1-2 hours is the sweet spot).
  6. Prints a report: minutes kept per source, clips written, anything too quiet or clipped to use.
"""
import json, os, re, subprocess, sys, tempfile

SR = 44100
HEAD, TAIL = 8.0, 8.0          # seconds trimmed from each file's start and end
SILENCE_DB, SILENCE_MIN = -38, 1.2
CLIP_MIN, CLIP_MAX = 180, 360  # seconds per output clip
EXTS = {".mp4", ".mov", ".m4a", ".mp3", ".wav", ".webm", ".mkv", ".aac", ".flac", ".ogg", ".opus"}


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path])
    return float(json.loads(r.stdout)["format"]["duration"])


def speech_spans(wav, total):
    """Spans of the file that aren't long silence, from ffmpeg's silencedetect."""
    r = run(["ffmpeg", "-hide_banner", "-i", wav, "-af", f"silencedetect=noise={SILENCE_DB}dB:d={SILENCE_MIN}", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    spans, pos = [], 0.0
    for s, e in zip(starts, ends + [total] * (len(starts) - len(ends))):
        if s - pos > 0.6:
            spans.append((pos, s + 0.25))   # keep a quarter-second of the pause
        pos = max(pos, e - 0.25)
    if total - pos > 0.6:
        spans.append((pos, total))
    return spans


def loudness(wav):
    r = run(["ffmpeg", "-hide_banner", "-i", wav, "-af", "loudnorm=I=-18:TP=-3:LRA=11:print_format=json", "-f", "null", "-"])
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    return json.loads(m.group(0)) if m else None


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]
    budget = float(sys.argv[sys.argv.index("--minutes") + 1]) * 60 if "--minutes" in sys.argv else 120 * 60
    os.makedirs(out, exist_ok=True)
    files = sorted(f for f in os.listdir(src) if os.path.splitext(f)[1].lower() in EXTS)
    if not files:
        print(f"No audio or video files in {src}"); sys.exit(1)
    report, clip_n, kept_total = [], 0, 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for f in files:
            if kept_total >= budget:
                break
            path = os.path.join(src, f)
            base = os.path.join(tmp, "base.wav")
            r = run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", "-af", "highpass=f=70", base])
            if r.returncode:
                report.append((f, 0, f"couldn't read: {r.stderr.strip()[:120]}")); continue
            total = duration(base)
            lo, hi = (HEAD, total - TAIL) if total > 60 else (0, total)
            spans = [(max(a, lo), min(b, hi)) for a, b in speech_spans(base, total) if b > lo and a < hi]
            spans = [(a, b) for a, b in spans if b - a > 0.6]
            # Group spans into 3-6 minute clips.
            groups, cur, cur_len = [], [], 0.0
            for a, b in spans:
                cur.append((a, b)); cur_len += b - a
                if cur_len >= CLIP_MAX:
                    groups.append(cur); cur, cur_len = [], 0.0
            if cur_len >= 30:
                groups.append(cur)
            kept = 0.0
            for g in groups:
                if kept_total >= budget:
                    break
                seg = os.path.join(tmp, "seg.wav")
                parts = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in g)
                run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", base, "-af", f"aselect='{parts}',asetpts=N/SR/TB", seg])
                stats = loudness(seg)
                if not stats or float(stats["input_i"]) < -45:
                    report.append((f, 0, "a clip was too quiet, skipped")); continue
                clip_n += 1
                name = os.path.join(out, f"josh_{clip_n:03d}.wav")
                run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", seg, "-af",
                     f"loudnorm=I=-18:TP=-3:LRA=11:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true",
                     "-ar", str(SR), "-sample_fmt", "s16", name])
                d = duration(name); kept += d; kept_total += d
            report.append((f, kept, f"{len(groups)} clip(s), {total / 60:.1f} min source"))
    print(f"\n{'source':<40} {'kept':>8}  notes")
    for f, k, note in report:
        print(f"{f[:40]:<40} {k / 60:>6.1f}m  {note}")
    print(f"\n{clip_n} clips, {kept_total / 60:.1f} minutes of speech in {out}")
    if kept_total < 30 * 60:
        print("Under 30 minutes: add more solo videos for a Professional clone (an Instant clone works from 1-2 minutes).")


if __name__ == "__main__":
    main()
