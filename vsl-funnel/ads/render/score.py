"""Original orchestral score for each ad, composed to the ad's own timeline.

Build: python3 score.py <script.py> <out.wav>
Needs fluidsynth + a GM soundfont (FluidR3_GM) and sox. The music follows a level curve
(MUSIC in the script: [(seconds, level 0-5)]) and lands an impact on every segment with hit=True.

Levels: 0 low string pedal · 1 solo piano ostinato · 2 + string pad · 3 + cellos, choir
4 + horn motif, timpani pulse · 5 full: driving strings, timpani 8ths, high strings.
Harmony: i-VI-III-VII in D minor (Dm Bb F C); the "villain" stretch (mood='dark') uses
Dm Gm A; the final white card resolves to F major (add9).
"""
import importlib.util, os, subprocess, sys
import mido

SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
BPM = 80
TPB = 480
SPB = 60 / BPM  # seconds per beat

CH = dict(piano=0, strings=1, slow=2, cello=3, choir=4, horn=5, timp=6, high=7, bass=8)
PROG = dict(piano=0, strings=48, slow=49, cello=42, choir=52, horn=60, timp=47, high=48, bass=43)

CHORDS = {
    "Dm": [38, 50, 53, 57, 62], "Bb": [34, 46, 50, 53, 58], "F": [41, 48, 53, 57, 60],
    "C": [36, 48, 52, 55, 60], "Gm": [43, 50, 55, 58, 62], "A": [45, 52, 57, 61, 64],
    "Fadd9": [41, 53, 55, 57, 60, 67],
}
BRIGHT = ["Dm", "Bb", "F", "C"]
DARK = ["Dm", "Gm", "Dm", "A"]


def load(path):
    s = importlib.util.spec_from_file_location("m", path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    return m


def compose(mod, mid_path):
    segs = mod.SCRIPT
    total = sum(g["d"] for g in segs)
    music = getattr(mod, "MUSIC", [(0, 1), (total * 0.3, 3), (total * 0.7, 5), (total - 6, 1)])
    hits_only = bool(os.environ.get("HITS_ONLY"))
    if hits_only: music = [(0, -1)]
    dark = getattr(mod, "DARK", [])  # [(start, end)] seconds
    hits, t = [], 0.0
    for g in segs:
        if g.get("hit"): hits.append(t)
        t += g["d"]
    white_at = next((sum(x["d"] for x in segs[:i]) for i, g in enumerate(segs) if g.get("bg") == "white"), total - 5)

    def level(sec):
        lv = 0
        for ts, l in music:
            if sec >= ts: lv = l
        return lv

    def is_dark(sec):
        return any(a <= sec < b for a, b in dark)

    ev = []  # (sec, msg)
    def note(ch, n, sec, dur, vel):
        ev.append((sec, mido.Message("note_on", channel=ch, note=n, velocity=max(1, min(127, int(vel))))))
        ev.append((sec + dur, mido.Message("note_off", channel=ch, note=n, velocity=0)))

    for name, ch in CH.items():
        ev.append((0, mido.Message("program_change", channel=ch, program=PROG[name])))
        ev.append((0, mido.Message("control_change", channel=ch, control=91, value=100)))  # reverb send
    ev.append((0, mido.Message("control_change", channel=CH["piano"], control=91, value=70)))

    bar = SPB * 4
    nbars = int(white_at / bar) + 1
    # music runs in bars until the white card; then a resolving chord
    for b in range(nbars):
        s0 = b * bar
        if s0 >= white_at: break
        lv = level(s0 + 0.01)
        prog = DARK if is_dark(s0 + 0.01) else BRIGHT
        c = CHORDS[prog[b % 4]]
        root = c[0]
        bar_end = min(s0 + bar, white_at)
        # level 0: low pedal
        if lv == 0:
            note(CH["slow"], root, s0, bar_end - s0, 50)
        # piano ostinato: 8ths, chord tones climbing (the "ticking" heart)
        if lv >= 1:
            pat = [c[1], c[2], c[3], c[2], c[1] + 12, c[3], c[2], c[3]]
            for i, n in enumerate(pat):
                ts = s0 + i * SPB / 2
                if ts >= bar_end: break
                note(CH["piano"], n + 12, ts, SPB / 2 * 0.95, 62 + 8 * (i % 2 == 0) + 6 * min(lv, 3))
            note(CH["piano"], root + 12, s0, bar * 0.9, 58)
        # string pad
        if lv >= 2:
            for n in c[1:4]:
                note(CH["slow"], n, s0, bar_end - s0, 48 + 10 * lv)
            note(CH["bass"], root, s0, bar_end - s0, 50 + 8 * lv)
        # cellos (quarter pulses) + choir
        if lv >= 3:
            for i in range(4):
                ts = s0 + i * SPB
                if ts < bar_end: note(CH["cello"], root + 12, ts, SPB * 0.85, 64 + 6 * lv)
            for n in (c[2] + 12, c[3] + 12):
                note(CH["choir"], n, s0, bar_end - s0, 40 + 9 * lv)
        # horn motif + timpani pulse
        if lv >= 4:
            motif = [c[3] + 12, c[2] + 12, c[3] + 12, c[4] + 12] if b % 2 == 0 else [c[4] + 12, c[3] + 12, c[2] + 12, c[3] + 12]
            durs = [1.5, 0.5, 1.0, 1.0]
            ts = s0
            for n, dd in zip(motif, durs):
                if ts < bar_end: note(CH["horn"], n - 12, ts, dd * SPB * 0.95, 70 + 7 * lv)
                ts += dd * SPB
            for i in (0, 2):
                ts = s0 + i * SPB
                if ts < bar_end: note(CH["timp"], root + 12 if root + 12 < 55 else root, ts, SPB, 70 + 6 * lv)
        # full: driving 8th strings + high strings
        if lv >= 5:
            for i in range(8):
                ts = s0 + i * SPB / 2
                if ts < bar_end:
                    note(CH["strings"], root + 24, ts, SPB / 2 * 0.8, 84)
                    note(CH["strings"], c[2] + 12, ts, SPB / 2 * 0.8, 72)
                    note(CH["timp"], root + 12 if root + 12 < 55 else root, ts, SPB / 2 * 0.6, 58 + 20 * (i % 4 == 0))
            for n in (c[3] + 24, c[4] + 24):
                note(CH["high"], n, s0, bar_end - s0, 70)

    # impacts on hits: timpani + low strings + cymbal, with a short crescendo roll into it
    for h in hits:
        roll = 0.9
        k = 0
        while k * 0.07 < roll:
            ts = h - roll + k * 0.07
            if ts > 0: note(CH["timp"], 41, ts, 0.07, 30 + 70 * (k * 0.07 / roll))
            k += 1
        note(CH["timp"], 38, h, 2.0, 127)
        note(CH["bass"], 26, h, 2.2, 120)
        note(CH["strings"], 38, h, 1.4, 120)
        note(CH["strings"], 50, h, 1.4, 115)
        ev.append((h, mido.Message("note_on", channel=9, note=49, velocity=100)))
        ev.append((h + 1.5, mido.Message("note_off", channel=9, note=49, velocity=0)))
        ev.append((h, mido.Message("note_on", channel=9, note=35, velocity=127)))
        ev.append((h + 0.5, mido.Message("note_off", channel=9, note=35, velocity=0)))

    # resolution on the white card
    for n in ([] if hits_only else CHORDS["Fadd9"]):
        note(CH["slow"], n, white_at, total - white_at + 2.5, 72)
        note(CH["choir"], n + 12, white_at, total - white_at + 2.5, 52) if n > 50 else None
    if not hits_only:
        note(CH["piano"], 65, white_at, 4.0, 70); note(CH["piano"], 72, white_at + 0.4, 3.6, 62); note(CH["piano"], 77, white_at + 0.8, 3.2, 56)
        note(CH["timp"], 41, white_at, 2.5, 90)

    # write
    mf = mido.MidiFile(ticks_per_beat=TPB); tr = mido.MidiTrack(); mf.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(BPM)))
    ev.sort(key=lambda e: (e[0], 0 if e[1].type in ("program_change", "control_change") else (1 if e[1].type == "note_off" else 2)))
    last = 0
    for sec, msg in ev:
        tick = int(round(sec / SPB * TPB))
        msg.time = max(0, tick - last); last = max(last, tick)
        tr.append(msg)
    mf.save(mid_path)
    return total


def main():
    script, out = sys.argv[1], sys.argv[2]
    mod = load(script)
    mid = out.replace(".wav", ".mid"); raw = out.replace(".wav", ".raw.wav")
    total = compose(mod, mid)
    subprocess.run(["fluidsynth", "-ni", "-q", "-F", raw, "-r", "48000", "-g", "0.6", "-R", "1", "-C", "1", SF2, mid], check=True)
    # hall reverb, gentle low-end lift, trim to the ad length plus a tail, fade, normalise
    subprocess.run(["sox", raw, out, "gain", "-4", "reverb", "45", "50", "90", "bass", "+3", "treble", "-1", "compand", "0.08,0.6", "6:-70,-70,-45,-28,-20,-17,0,-10", "-4", "-90", "0.1",
                    "trim", "0", f"{total + 0.3:.2f}", "fade", "t", "0.05", f"{total + 0.3:.2f}", "2.2", "gain", "-n", "-1.5"], check=True)
    os.remove(raw)
    print(out, f"{total:.1f}s")


if __name__ == "__main__":
    main()
