import { type Clip, type EditPlan, type Range, type Word, normalise, toOutput, total } from './plan';

/**
 * G&L Studio: from an edit plan to the exact ffmpeg work the editor container runs. Pure (no I/O); unit-tested in
 * test/studio-ffmpeg.test.ts. The container (containers/studio-editor/server.mjs) only substitutes {raw}, {dir} and
 * {loudnorm} (the numbers from the measure pass) and runs the steps in order.
 *
 * The edit, in one graph:
 *  - video: timestamps from zero, constant frame rate at the SOURCE rate, then `select` keeps the planned frames and
 *    `setpts` closes the gaps. No scale filter: the output has the source's width and height (4K stays 4K).
 *    Cut points are snapped to the frame grid so picture and sound stay in sync after hundreds of cuts.
 *  - sound: each kept piece is trimmed with two frames of overlap and joined with a 2-frame crossfade (no clicks,
 *    no drift: every overlap is taken back by its crossfade), then a high-pass at 80 Hz, gentle denoise (afftdn) and
 *    loudness normalised to -14 LUFS in two passes (measure, then apply with the measured numbers).
 *  - captions: an ASS file made from the transcript, remapped to the edited timeline, burned in (white, navy edge).
 *  - H.264 high profile, CRF 18, AAC 192k, +faststart. Shorts: 9:16 crops of the clips at up to 1080x1920.
 */

export interface Probe { duration: number; width: number; height: number; fps: number; rFps?: number; hasAudio: boolean; sampleRate?: number; vcodec?: string | null }
export interface RenderOptions {
  captions: boolean;
  shorts: boolean;
  preset?: string;
  crf?: number;
  layout?: string | null;
  words?: Word[];
  title?: string;
}
export interface RenderStep { name: string; label: string; args: string[]; weight: number; durationS: number; measureLoudnorm?: boolean }
export interface RenderUpload { file: string; kind: string; contentType: string; label: string; optional?: boolean }
export interface RenderJob { steps: RenderStep[]; files: Record<string, string>; uploads: RenderUpload[]; fps: number; keep: Range[]; keptS: number; shorts: (Clip & { n: number; file: string; width: number; height: number })[] }

export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 } as const;
export const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'] as const;
export const XFADE_FRAMES = 2;
export const SHORT_W = 1080;
export const SHORT_H = 1920;
/** Where the face sits across the frame for each recorder layout (0 = left edge, 1 = right), for the shorts' 9:16 crop. */
export const FACE_X: Record<string, number> = { orbit: 0.5, split: 0.5, spotlight: 0.5, stage: 0.5, vertical: 0.5, cinema: 0.5 };

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/** The source frame rate, as a standard rate when it is close to one (browser recordings report odd averages). */
export function pickFps(p: Pick<Probe, 'fps' | 'rFps'>): number {
  let f = Number(p.fps) || 0;
  if (!(f > 1 && f <= 240)) f = Number(p.rFps) || 0;
  if (!(f > 1 && f <= 240)) return 30;
  const near = [...STANDARD_FPS].sort((a, b) => Math.abs(a - f) - Math.abs(b - f))[0];
  if (Math.abs(near - f) / near < 0.03) return near;
  return Math.max(10, Math.min(60, Math.round(f)));
}
/** ffmpeg's spelling of a rate (29.97 → 30000/1001). */
export const fpsText = (f: number) => (Math.abs(f - 29.97) < 0.01 ? '30000/1001' : Math.abs(f - 59.94) < 0.01 ? '60000/1001' : Math.abs(f - 23.976) < 0.01 ? '24000/1001' : String(f));
const exactFps = (f: number) => (Math.abs(f - 29.97) < 0.01 ? 30000 / 1001 : Math.abs(f - 59.94) < 0.01 ? 60000 / 1001 : Math.abs(f - 23.976) < 0.01 ? 24000 / 1001 : f);

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const t = (n: number) => r6(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

/** Keep ranges on the frame grid (each boundary at a whole frame), so frames kept = seconds kept x fps exactly. */
export function snapToFrames(keep: Range[], fps: number, duration: number): Range[] {
  const f = exactFps(fps);
  const last = Math.floor(duration * f + 1e-6);
  // Whole frames, merged where they touch (normalise() would round to milliseconds and leave the grid).
  const frames = keep
    .map((r) => ({ a: Math.max(0, Math.round(r.in * f)), b: Math.min(last, Math.round(r.out * f)) }))
    .filter((r) => r.b - r.a >= 1)
    .sort((x, y) => x.a - y.a);
  const merged: { a: number; b: number }[] = [];
  for (const r of frames) {
    const prev = merged[merged.length - 1];
    if (prev && r.a <= prev.b) prev.b = Math.max(prev.b, r.b);
    else merged.push({ ...r });
  }
  return merged.map((r) => ({ in: r6(r.a / f), out: r6(r.b / f) }));
}

/** The select expression: frames whose time falls in a kept piece (half-frame tolerance, end exclusive). */
export function selectExpr(keep: Range[], fps: number): string {
  const h = 0.5 / exactFps(fps);
  return groupSum(keep.map((r) => `between(t,${t(r.in - h)},${t(r.out - h)})`));
}
/** The container's ffmpeg (5.1) refuses a flat sum of more than about 100 terms, so long edits are summed in nested groups of 40. */
export function groupSum(terms: string[], size = 40): string {
  if (terms.length <= size) return terms.join('+');
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += size) groups.push(`(${terms.slice(i, i + size).join('+')})`);
  return groupSum(groups, size);
}

/** Audio for the kept pieces: 2-frame overlaps joined by crossfades, cleaned and loudness-normalised. */
export function audioGraph(keep: Range[], fps: number, duration: number, loud: 'measure' | 'apply' | 'single', inLabel = '[0:a]', outLabel = '[aout]'): string {
  const d = r6(XFADE_FRAMES / exactFps(fps));
  const n = keep.length;
  const parts: string[] = [];
  parts.push(`${inLabel}asetpts=PTS-STARTPTS,aresample=48000,asplit=${n}${keep.map((_, i) => `[i${i}]`).join('')}`);
  keep.forEach((r, i) => {
    const end = i < n - 1 ? Math.min(duration, r.out + d) : r.out;
    parts.push(`[i${i}]atrim=start=${t(r.in)}:end=${t(end)},asetpts=PTS-STARTPTS[s${i}]`);
  });
  let cur = '[s0]';
  for (let i = 1; i < n; i++) {
    parts.push(`${cur}[s${i}]acrossfade=d=${t(d)}:c1=tri:c2=tri[x${i}]`);
    cur = `[x${i}]`;
  }
  const ln = `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  const norm = loud === 'measure' ? `${ln}:print_format=json` : loud === 'apply' ? `${ln}{loudnorm}` : ln;
  parts.push(`${cur}highpass=f=80,afftdn=nf=-25,${norm},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${outLabel}`);
  return parts.join(';\n');
}

export interface VideoOpts { crop?: { w: number; h: number; x: number; y: number } | null; scale?: { w: number; h: number } | null; captionsFile?: string | null; evenCrop?: boolean }
export function videoGraph(keep: Range[], fps: number, o: VideoOpts = {}, inLabel = '[0:v]', outLabel = '[vout]'): string {
  const chain = [`setpts=PTS-STARTPTS`, `fps=${fpsText(fps)}`, `select='${selectExpr(keep, fps)}'`, `setpts=N/FRAME_RATE/TB`];
  if (o.crop) chain.push(`crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}`);
  else if (o.evenCrop) chain.push('crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
  if (o.scale) chain.push(`scale=${o.scale.w}:${o.scale.h}:flags=lanczos`, 'setsar=1');
  chain.push('format=yuv420p');
  if (o.captionsFile) chain.push(`subtitles=filename=${o.captionsFile}`);
  return `${inLabel}${chain.join(',')}${outLabel}`;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const evenPos = (n: number) => Math.max(0, Math.floor(n / 2) * 2);

/** The 9:16 crop of a frame, centred on the layout's face column, and the output size (never above 1080x1920, never upscaled past the crop). */
export function shortCrop(width: number, height: number, layout?: string | null) {
  const faceX = FACE_X[layout ?? ''] ?? 0.5;
  let cw: number, ch: number;
  if (width / height > 9 / 16) { ch = even(height); cw = even((height * 9) / 16); } else { cw = even(width); ch = even((width * 16) / 9); }
  cw = Math.min(cw, even(width)); ch = Math.min(ch, even(height));
  const x = evenPos(Math.min(Math.max(0, faceX * width - cw / 2), width - cw));
  const y = evenPos(Math.max(0, (height - ch) / 2));
  const outH = Math.min(SHORT_H, ch);
  const outW = even((outH * 9) / 16);
  return { crop: { w: cw, h: ch, x, y }, scale: { w: outW, h: even(outH) } };
}

// ───────────── captions (ASS) ─────────────

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const assText = (s: string) => s.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

export interface Cue { start: number; end: number; text: string }

/** Words on the edited timeline, grouped into short caption lines. */
export function captionCues(words: Word[], keep: Range[], o: { maxWords?: number; maxChars?: number; maxS?: number } = {}): Cue[] {
  const maxWords = o.maxWords ?? 7, maxChars = o.maxChars ?? 38, maxS = o.maxS ?? 3;
  const mapped = words
    .map((w) => {
      const s = toOutput(w.s, keep);
      if (s === null) return null;
      const e = toOutput(w.e, keep) ?? s + Math.min(0.6, Math.max(0.05, w.e - w.s));
      return { w: assText(w.w), s, e: Math.max(e, s + 0.05) };
    })
    .filter((x): x is { w: string; s: number; e: number } => Boolean(x && x.w));
  const cues: Cue[] = [];
  let cur: typeof mapped = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].s, end: cur[cur.length - 1].e + 0.2, text: cur.map((x) => x.w).join(' ') });
    cur = [];
  };
  for (const w of mapped) {
    const prev = cur[cur.length - 1];
    const text = [...cur.map((x) => x.w), w.w].join(' ');
    if (prev && (w.s - prev.e > 0.6 || cur.length >= maxWords || text.length > maxChars || w.e - cur[0].s > maxS)) flush();
    cur.push(w);
    if (/[.?!]$/.test(w.w)) flush();
  }
  flush();
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  return cues.filter((c) => c.end > c.start);
}

/** A complete ASS file: clean white text with a navy edge and soft navy shadow, bottom centre. */
export function buildAss(cues: Cue[], width: number, height: number, o: { sizeRatio?: number; marginRatio?: number } = {}): string {
  const size = Math.round(height * (o.sizeRatio ?? (width >= height ? 0.046 : 0.034)));
  const outline = Math.max(1, Math.round(height * 0.0022));
  const shadow = Math.max(1, Math.round(height * 0.003));
  const marginV = Math.round(height * (o.marginRatio ?? (width >= height ? 0.065 : 0.2)));
  const marginLR = Math.round(width * 0.08);
  // ASS colours are &HAABBGGRR. White text; navy #0f2c5c for the edge and the shadow.
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'ScaledBorderAndShadow: yes', 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H005C2C0F,&H805C2C0F,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text)}`),
    '',
  ].join('\n');
}

// ───────────── the whole render job ─────────────

/** Steps, files and uploads for one render. Paths use the container's placeholders {raw} and {dir}. */
export function buildRenderJob(plan: Pick<EditPlan, 'keep' | 'clips' | 'captions' | 'title'>, probe: Probe, o: RenderOptions): RenderJob {
  const fps = pickFps(probe);
  const D = probe.duration;
  const keep = snapToFrames(normalise(plan.keep, D), fps, D);
  if (!keep.length) throw new Error('The plan keeps nothing.');
  const keptS = total(keep);
  const preset = (PRESETS as readonly string[]).includes(o.preset ?? '') ? o.preset! : 'medium';
  const crf = Number.isFinite(o.crf) ? Math.max(12, Math.min(30, Math.round(o.crf!))) : 18;
  const captions = o.captions && plan.captions.style !== 'none' && (o.words?.length ?? 0) > 0;
  const files: Record<string, string> = {};
  const steps: RenderStep[] = [];
  const uploads: RenderUpload[] = [];
  const odd = probe.width % 2 === 1 || probe.height % 2 === 1;
  const encode = ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', fpsText(fps), '-g', String(Math.round(exactFps(fps) * 2))];
  const audioOut = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
  const mux = ['-movflags', '+faststart', '-max_muxing_queue_size', '4096'];

  if (captions) files['captions.ass'] = buildAss(captionCues(o.words!, keep), probe.width - (odd ? probe.width % 2 : 0), probe.height - (odd ? probe.height % 2 : 0));
  const v = videoGraph(keep, fps, { evenCrop: odd, captionsFile: captions ? '{dir}/captions.ass' : null });
  if (probe.hasAudio) {
    files['measure.txt'] = audioGraph(keep, fps, D, 'measure');
    files['graph.txt'] = `${v};\n${audioGraph(keep, fps, D, 'apply')}`;
    steps.push({ name: 'measure', label: 'Measuring loudness', args: ['-i', '{raw}', '-vn', '-filter_complex_script', '{dir}/measure.txt', '-map', '[aout]', '-f', 'null', '-'], weight: 0.08, durationS: keptS, measureLoudnorm: true });
    steps.push({ name: 'render', label: 'Rendering the edit', args: ['-i', '{raw}', '-filter_complex_script', '{dir}/graph.txt', '-map', '[vout]', '-map', '[aout]', ...encode, ...audioOut, ...mux, '{dir}/edited.mp4'], weight: 1, durationS: keptS });
  } else {
    files['graph.txt'] = v;
    steps.push({ name: 'render', label: 'Rendering the edit', args: ['-i', '{raw}', '-filter_complex_script', '{dir}/graph.txt', '-map', '[vout]', '-an', ...encode, ...mux, '{dir}/edited.mp4'], weight: 1, durationS: keptS });
  }
  uploads.push({ file: 'edited.mp4', kind: 'edited', contentType: 'video/mp4', label: 'Saving the edit' });

  const shorts: RenderJob['shorts'] = [];
  if (o.shorts) {
    const { crop, scale } = shortCrop(probe.width, probe.height, o.layout);
    plan.clips.slice(0, 3).forEach((c, i) => {
      const n = i + 1;
      // The clip's own cuts: the plan's keep ranges inside it, shifted to start at zero.
      const inside = keep.map((r) => ({ in: Math.max(r.in, c.in), out: Math.min(r.out, c.out) })).filter((r) => r.out - r.in >= 0.3).map((r) => ({ in: r6(r.in - c.in), out: r6(r.out - c.in) }));
      const len = r6(c.out - c.in);
      const local = snapToFrames(inside, fps, len);
      if (!local.length) return;
      const file = `short-${n}.mp4`;
      const capFile = captions ? `short-${n}.ass` : null;
      if (capFile) {
        const ws = (o.words ?? []).filter((w) => w.s >= c.in && w.e <= c.out).map((w) => ({ ...w, s: w.s - c.in, e: w.e - c.in }));
        files[capFile] = buildAss(captionCues(ws, local, { maxWords: 4, maxChars: 22, maxS: 2.2 }), scale.w, scale.h);
      }
      const vg = videoGraph(local, fps, { crop, scale, captionsFile: capFile ? `{dir}/${capFile}` : null });
      files[`short-${n}.txt`] = probe.hasAudio ? `${vg};\n${audioGraph(local, fps, len, 'single')}` : vg;
      const maps = probe.hasAudio ? ['-map', '[vout]', '-map', '[aout]', ...audioOut] : ['-map', '[vout]', '-an'];
      steps.push({ name: `short-${n}`, label: `Cutting short ${n}`, args: ['-ss', t(c.in), '-t', t(len), '-i', '{raw}', '-filter_complex_script', `{dir}/short-${n}.txt`, ...maps, ...encode, ...mux, `{dir}/${file}`], weight: 0.12, durationS: total(local) });
      uploads.push({ file, kind: `short-${n}`, contentType: 'video/mp4', label: `Saving short ${n}`, optional: true });
      shorts.push({ ...c, n, file, width: scale.w, height: scale.h });
    });
  }
  return { steps, files, uploads, fps, keep, keptS: r6(keptS), shorts };
}

/** "4K", "1440p", "1080p", "720p" or "<w>x<h>" for the Drive file name. */
export function resolutionLabel(width: number, height: number): string {
  const short = Math.min(width, height), long = Math.max(width, height);
  if (long >= 3800 || short >= 2100) return '4K';
  if (short >= 1400) return '1440p';
  if (short >= 1060) return '1080p';
  if (short >= 700) return '720p';
  return `${width}x${height}`;
}
