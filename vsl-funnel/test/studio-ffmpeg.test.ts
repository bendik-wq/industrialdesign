import { describe, expect, it } from 'vitest';
import { audioGraph, buildAss, buildRenderJob, captionCues, pickFps, resolutionLabel, selectExpr, shortCrop, snapToFrames, videoGraph } from '../src/studio/ffmpeg';
import { rulesPlan } from '../src/studio/plan';

// G&L Studio: the ffmpeg work is a pure function of the plan and the probe. The container only fills {raw}, {dir} and
// {loudnorm} and runs it (the real render was checked end to end in Docker: 3840x2160 in, 3840x2160 out, length as planned).

const probe4k = { duration: 60, width: 3840, height: 2160, fps: 30, rFps: 30, hasAudio: true };
const plan = {
  title: 'T', captions: { style: 'clean' as const },
  keep: [{ in: 0, out: 10.155 }, { in: 12.863, out: 15.6 }, { in: 20, out: 25 }, { in: 26, out: 60 }],
  clips: [{ in: 30, out: 60, title: 'Best bit' }],
};
const words = Array.from({ length: 40 }, (_, i) => ({ w: i % 6 === 5 ? 'end.' : 'word', s: i * 1.4 + 0.2, e: i * 1.4 + 0.9 }));

describe('frame rate and the frame grid', () => {
  it('pickFps snaps browser averages to the nearest standard rate', () => {
    expect(pickFps({ fps: 30 })).toBe(30);
    expect(pickFps({ fps: 29.97 })).toBe(29.97);
    expect(pickFps({ fps: 59.7 })).toBe(59.94);
    expect(pickFps({ fps: 0, rFps: 1000 })).toBe(30); // WebM's 1000/1 time base is not a frame rate
    expect(pickFps({ fps: 17.2 })).toBe(17);
  });
  it('snapToFrames puts every cut on a whole frame, so frames kept equals seconds kept times fps', () => {
    const k = snapToFrames([{ in: 0.01, out: 1.02 }, { in: 2.049, out: 3 }], 30, 60);
    for (const r of k) { expect(Math.abs(r.in * 30 - Math.round(r.in * 30))).toBeLessThan(1e-4); expect(Math.abs(r.out * 30 - Math.round(r.out * 30))).toBeLessThan(1e-4); }
    expect(k[0]).toEqual({ in: 0, out: 1.033333 });
  });
  it('select keeps frames by time with a half-frame tolerance (end exclusive)', () => {
    expect(selectExpr([{ in: 0, out: 1 }, { in: 2, out: 3 }], 25)).toBe('between(t,-0.02,0.98)+between(t,1.98,2.98)');
  });
});

describe('audio graph', () => {
  it('one trim per kept piece, two-frame overlaps taken back by crossfades, then clean-up and loudness', () => {
    const g = audioGraph([{ in: 0, out: 10 }, { in: 20, out: 30 }, { in: 40, out: 50 }], 30, 60, 'apply');
    expect(g).toContain('asplit=3[i0][i1][i2]');
    expect(g).toContain('[i0]atrim=start=0:end=10.066667'); // 2 frames at 30 fps of extra source
    expect(g).toContain('[i2]atrim=start=40:end=50,'); // the last piece is not extended
    expect(g.match(/acrossfade=d=0\.066667/g)).toHaveLength(2);
    expect(g).toContain('highpass=f=80,afftdn=nf=-25,loudnorm=I=-14:TP=-1.5:LRA=11{loudnorm}');
    expect(g.trim().endsWith('[aout]')).toBe(true);
    expect(audioGraph([{ in: 0, out: 5 }], 30, 60, 'measure')).toContain('print_format=json');
    expect(audioGraph([{ in: 0, out: 5 }], 30, 60, 'single')).not.toContain('acrossfade');
  });
});

describe('video graph', () => {
  it('never scales the main edit: constant frame rate, select, timestamps closed up, captions burned in', () => {
    const v = videoGraph([{ in: 0, out: 1 }], 30, { captionsFile: '{dir}/captions.ass' });
    expect(v).toMatch(/^\[0:v\]setpts=PTS-STARTPTS,fps=30,select='between\(t,[^']+\)',setpts=N\/FRAME_RATE\/TB,format=yuv420p,subtitles=filename=\{dir\}\/captions\.ass\[vout\]$/);
    expect(v).not.toMatch(/scale=/);
  });
  it('29.97 is written as a fraction', () => {
    expect(videoGraph([{ in: 0, out: 1 }], 29.97)).toContain('fps=30000/1001');
  });
});

describe('the render job', () => {
  it('4K stays 4K: no scale in the main graph, H.264 high CRF 18, AAC 192k, faststart, two loudness passes', () => {
    const job = buildRenderJob(plan, probe4k, { captions: true, shorts: false, words });
    expect(job.steps.map((s) => s.name)).toEqual(['measure', 'render']);
    expect(job.steps[0].measureLoudnorm).toBe(true);
    const graph = job.files['graph.txt'];
    expect(graph.split(';\n')[0]).not.toMatch(/scale=|crop=/);
    const args = job.steps[1].args.join(' ');
    for (const a of ['-c:v libx264', '-profile:v high', '-crf 18', '-preset medium', '-pix_fmt yuv420p', '-c:a aac', '-b:a 192k', '-movflags +faststart', '-r 30', '{dir}/edited.mp4'])
      expect(args).toContain(a);
    expect(job.uploads).toEqual([{ file: 'edited.mp4', kind: 'edited', contentType: 'video/mp4', label: 'Saving the edit' }]);
    // Length: the frame-snapped keep.
    expect(job.keptS).toBeCloseTo(305 / 30 + (468 - 386) / 30 + 5 + 34, 4); // 10.155 → frame 305, 12.863 → 386, 15.6 → 468
    expect(job.files['captions.ass']).toContain('PlayResX: 3840');
    expect(job.files['captions.ass']).toContain('PlayResY: 2160');
  });
  it('captions off (setting or plan) and silent sources', () => {
    expect(buildRenderJob(plan, probe4k, { captions: false, shorts: false, words }).files['captions.ass']).toBeUndefined();
    expect(buildRenderJob({ ...plan, captions: { style: 'none' } }, probe4k, { captions: true, shorts: false, words }).files['captions.ass']).toBeUndefined();
    const silent = buildRenderJob(plan, { ...probe4k, hasAudio: false }, { captions: false, shorts: false });
    expect(silent.steps.map((s) => s.name)).toEqual(['render']);
    expect(silent.steps[0].args).toContain('-an');
  });
  it('odd sizes are cropped by one pixel (yuv420p), never scaled', () => {
    const job = buildRenderJob(plan, { ...probe4k, width: 1921, height: 1081 }, { captions: false, shorts: false });
    expect(job.files['graph.txt']).toContain('crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
    expect(job.files['graph.txt']).not.toContain('scale=');
  });
  it('shorts: 9:16 crop scaled to 1080x1920, cut with the plan inside the clip, captions sized for vertical', () => {
    const job = buildRenderJob(plan, probe4k, { captions: true, shorts: true, words, layout: 'orbit' });
    expect(job.shorts).toHaveLength(1);
    expect(job.shorts[0]).toMatchObject({ n: 1, width: 1080, height: 1920, file: 'short-1.mp4' });
    const s = job.steps.find((x) => x.name === 'short-1')!;
    expect(s.args.slice(0, 6)).toEqual(['-ss', '30', '-t', '30', '-i', '{raw}']);
    expect(job.files['short-1.txt']).toContain('crop=1214:2160:1312:0,scale=1080:1920:flags=lanczos');
    expect(job.files['short-1.ass']).toContain('PlayResX: 1080');
    expect(job.uploads.map((u) => u.kind)).toEqual(['edited', 'short-1']);
  });
  it('a plan that keeps nothing is refused', () => {
    expect(() => buildRenderJob({ ...plan, keep: [] }, probe4k, { captions: false, shorts: false })).toThrow(/keeps nothing/);
  });
  it('works from the rules plan as well', () => {
    const p = rulesPlan({ title: 't', duration: 60, transcript: { words, segments: [] }, silences: [{ start: 40, end: 50 }], markers: [] });
    expect(buildRenderJob(p, probe4k, { captions: true, shorts: true, words }).steps.length).toBeGreaterThanOrEqual(2);
  });
});

describe('crop, captions, labels', () => {
  it('shortCrop: never larger than the source, centred on the face column', () => {
    expect(shortCrop(1920, 1080)).toEqual({ crop: { w: 606, h: 1080, x: 656, y: 0 }, scale: { w: 606, h: 1080 } });
    expect(shortCrop(1080, 1920).scale).toEqual({ w: 1080, h: 1920 });
  });
  it('captionCues group words on the edited timeline and skip cut words', () => {
    const cues = captionCues([{ w: 'Hello', s: 0, e: 0.4 }, { w: 'there.', s: 0.5, e: 0.9 }, { w: 'cut', s: 5, e: 5.3 }, { w: 'Back', s: 10, e: 10.4 }], [{ in: 0, out: 2 }, { in: 9.5, out: 12 }]);
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'Back']);
    expect(cues[1].start).toBeCloseTo(2.5, 5);
  });
  it('buildAss: white text, navy edge, braces and backslashes removed', () => {
    const ass = buildAss([{ start: 1, end: 2.5, text: 'a {b} c\\d' }], 1920, 1080);
    expect(ass).toContain('&H00FFFFFF,&H00FFFFFF,&H005C2C0F');
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,a b c/d');
  });
  it('resolution labels for the Drive name', () => {
    expect(resolutionLabel(3840, 2160)).toBe('4K');
    expect(resolutionLabel(2560, 1440)).toBe('1440p');
    expect(resolutionLabel(1920, 1080)).toBe('1080p');
    expect(resolutionLabel(1280, 720)).toBe('720p');
    expect(resolutionLabel(1080, 1920)).toBe('1080p');
    expect(resolutionLabel(640, 360)).toBe('640x360');
  });
});
