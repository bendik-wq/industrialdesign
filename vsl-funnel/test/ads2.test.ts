import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { approveAction, listActions } from '../src/ops/actions';
import { syncAdLevel, videoNumbers } from '../src/integrations/meta-ads';
import { adsTargets, hookHold, runAutopilot, weakHook } from '../src/marketing/autopilot';
import { adProblems, conceptsView, draftRound, industryLink, industryRollup, loadCustomerLanguage, metricsOf, ruleAngles, templateAds, AWARENESS, FRAMEWORKS, DESIRES, type ConceptSpec } from '../src/marketing/concepts';
import { INDUSTRIES } from '../src/landers/catalog';
import { ELEMENTS, FACT_LINES, OFFER_EMAILS, allFactLines, checkPasted, checkValueEquation, suggestionsFor, valueEquationReport } from '../src/marketing/value-equation';
import { auditCopy } from '../src/content/copy-rules';
import { buildPlan, videoRule } from '../src/audiences/catalog';
import { segmentIds } from '../src/audiences/segments';
import { CREATE_KIND, maybeSyncAudiences, proposeCreateAll } from '../src/audiences/sync';
import { draftHalo, haloReport, haloSpec, haloStates } from '../src/audiences/halo';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const BASE: Record<string, string> = { META_ADS_TOKEN: 'read_tok', META_AD_ACCOUNT_ID: '123456', SITE_NAME: 'G&L', SALES_TIMEZONE: 'Australia/Sydney' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...BASE, ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });
const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const n = (db: DatabaseSync, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

// ───────────── 1. Hook rate and hold rate ─────────────

describe('hook rate and hold rate per video ad', () => {
  it('reads 3-second views, ThruPlays and plays to 50% from Meta insights, and the video behind each ad', async () => {
    expect(videoNumbers({ actions: [{ action_type: 'link_click', value: '9' }, { action_type: 'video_view', value: '300' }], video_thruplay_watched_actions: [{ action_type: 'video_view', value: '120' }], video_p50_watched_actions: [{ value: '90' }] }))
      .toEqual({ video3s: 300, thruplays: 120, p50: 90 });
    expect(videoNumbers({ actions: [{ action_type: 'link_click', value: '9' }] })).toBeNull(); // an image ad

    const db = freshDb(); const rt = makeRt(db);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/insights')) return json(200, { data: [
        { ad_id: '9001', ad_name: 'Video ad', date_start: ymd(Date.now()), spend: '40', impressions: '2000', reach: '1500', clicks: '30', inline_link_clicks: '20', account_currency: 'USD',
          actions: [{ action_type: 'video_view', value: '300' }], video_thruplay_watched_actions: [{ action_type: 'video_view', value: '150' }], video_p50_watched_actions: [{ action_type: 'video_view', value: '110' }] },
        { ad_id: '9002', ad_name: 'Image ad', date_start: ymd(Date.now()), spend: '10', impressions: '900', reach: '800', clicks: '9', inline_link_clicks: '8', account_currency: 'USD' },
      ] });
      if (String(url).includes('/ads?')) return json(200, { data: [{ id: '9001', name: 'Video ad', status: 'ACTIVE', adset_id: '77', creative: { id: 'c1', object_story_spec: { video_data: { video_id: '555000' } } } }, { id: '9002', name: 'Image ad', creative: { id: 'c2' } }] });
      return json(200, { data: [] });
    }));
    await syncAdLevel(rt, 7);
    const ins = urls.find((u) => u.includes('/insights'))!;
    expect(decodeURIComponent(ins)).toMatch(/fields=[^&]*actions,video_thruplay_watched_actions,video_p50_watched_actions/);
    expect(decodeURIComponent(urls.find((u) => u.includes('/ads?'))!)).toContain('creative{id,video_id,object_story_spec{video_data{video_id}}}');
    expect(db.prepare("SELECT video_3s, thruplays, video_p50 FROM ad_insights WHERE ad_id = '9001'").get()).toEqual({ video_3s: 300, thruplays: 150, video_p50: 110 });
    expect(db.prepare("SELECT video_3s, thruplays FROM ad_insights WHERE ad_id = '9002'").get()).toEqual({ video_3s: null, thruplays: null });
    expect((db.prepare("SELECT video_id FROM ad_entities WHERE id = '9001'").get() as { video_id: string }).video_id).toBe('555000');
  });

  it('computes the rates and calls "weak hook, good body" only with enough impressions and a good hold (pure)', () => {
    const t = adsTargets({});
    expect(t).toMatchObject({ hookFloor: 25, holdGood: 30, hookMinImpressions: 2000 });
    const days = [{ impressions: 4000, video3s: 600, thruplays: 300 }, { impressions: 1000, video3s: null, thruplays: null }];
    expect(hookHold(days)).toEqual({ video3s: 600, thruplays: 300, hookRate: 15, holdRate: 50 });
    expect(hookHold([{ impressions: 100 }])).toEqual({ video3s: null, thruplays: null, hookRate: null, holdRate: null });
    const weak = weakHook({ impressions: 4000, video3s: 600, thruplays: 300, hookRate: 15, holdRate: 50 }, t)!;
    expect(weak.rule).toBe('weak_hook');
    expect(weak.reasons.join(' ')).toMatch(/Hook rate 15\.0%.*under the 25% line.*Hold rate 50\.0%/);
    expect(weakHook({ impressions: 1500, video3s: 200, thruplays: 100, hookRate: 13, holdRate: 50 }, t)).toBeNull(); // too few impressions
    expect(weakHook({ impressions: 4000, video3s: 600, thruplays: 60, hookRate: 15, holdRate: 10 }, t)).toBeNull(); // the body loses them too
    expect(weakHook({ impressions: 4000, video3s: 1600, thruplays: 800, hookRate: 40, holdRate: 50 }, t)).toBeNull(); // the hook works
    expect(weakHook({ impressions: 4000, video3s: 600, thruplays: 300, hookRate: 15, holdRate: 50 }, adsTargets({ ADS_HOOK_RATE_FLOOR: '10' }))).toBeNull();
  });

  it('the autopilot proposes hook-only variants of a concept ad with a weak hook (once), and shows both rates in concept results', async () => {
    const db = freshDb(); const now = Date.now(); const rt = makeRt(db);
    await draftRound(rt, {}, null, now - 10 * DAY);
    const ads = db.prepare('SELECT a.id, a.utm_content, a.hook, a.body, a.concept_id FROM ads_concept_ads a JOIN ads_concepts c ON c.id = a.concept_id ORDER BY c.idx, a.idx').all() as { id: string; utm_content: string; hook: string; body: string; concept_id: string }[];
    ads.forEach((a, i) => db.prepare("UPDATE ads_concept_ads SET status = 'launched', meta_ad_id = ? WHERE id = ?").run(String(80000 + i), a.id));
    const ins = db.prepare("INSERT INTO ad_insights (ad_id, day, ad_name, spend, impressions, reach, link_clicks, currency, video_3s, thruplays, updated_at) VALUES (?, ?, ?, 20, ?, ?, 10, 'USD', ?, ?, ?)");
    // Ad 2 (concept 1, ad 2): 3,000 impressions, 300 three-second views (10% hook), 150 ThruPlays (50% hold).
    ins.run('80001', ymd(now - DAY), `x (${ads[1].utm_content})`, 3000, 2500, 300, 150, now);
    ins.run('80000', ymd(now - DAY), `x (${ads[0].utm_content})`, 3000, 2500, 1200, 600, now); // strong hook
    // A Meta ad made outside Funnel HQ with a weak hook: badge only, no draft (no stored body).
    ins.run('99999', ymd(now - DAY), 'Hand-made video', 3000, 2500, 300, 150, now);
    db.prepare("INSERT INTO ad_entities (id, level, name, status, effective_status, updated_at) VALUES ('80001', 'ad', ?, 'ACTIVE', 'ACTIVE', ?), ('99999', 'ad', 'Hand-made video', 'ACTIVE', 'ACTIVE', ?)").run(`x (${ads[1].utm_content})`, now, now);
    // Clear the round's own launch proposal so only the autopilot's show.
    db.prepare("UPDATE ops_actions SET status = 'rejected'").run();

    const out = await runAutopilot(rt, now);
    const props = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    const hookProps = props.filter((p) => /Weak hook, good body/.test(p.summary));
    expect(hookProps).toHaveLength(1);
    expect(out.proposed).toContain(hookProps[0].id);
    expect(hookProps[0].detail).toMatch(/Hook rate 10\.0%/);
    expect(hookProps[0].detail).toMatch(/only the hook changes/);
    const variants = db.prepare("SELECT hook, body, parent_ad_id, utm_content FROM ads_concept_ads WHERE kind = 'hook_variant'").all() as { hook: string; body: string; parent_ad_id: string; utm_content: string }[];
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(v.parent_ad_id).toBe(ads[1].id);
      expect(v.body).toBe(ads[1].body);
      expect(v.hook).not.toBe(ads[1].hook);
      expect(v.utm_content.startsWith(`${ads[1].utm_content}-h`)).toBe(true);
    }
    // Once per ad: the next run proposes nothing new for it.
    await runAutopilot(rt, now + 3600_000);
    expect((await listActions(rt, { dept: 'marketing', status: 'proposed' })).filter((p) => /Weak hook/.test(p.summary))).toHaveLength(1);

    const v = await conceptsView(rt, now);
    const c1 = v.rounds.find((r) => r.kind === 'concepts')!.concepts.find((c) => c.idx === 1)!;
    // Concept 1: 6,000 impressions, 1,500 three-second views, 750 ThruPlays.
    expect(c1.metrics).toMatchObject({ impressions: 6000, hookRate: 25, holdRate: 50 });
    expect(c1.ads.find((a) => a.id === ads[1].id)!.results).toMatchObject({ hookRate: 10, holdRate: 50 });
    expect(v.rounds.find((r) => r.kind === 'concepts')!.concepts.find((c) => c.idx === 2)!.metrics!.hookRate).toBeNull(); // no video numbers
  });

  it('metricsOf leaves image ads out of the hook rate', () => {
    const r = (impressions: number, video3s: number | null, thruplays: number | null) => ({ spend: 1, registrants: 0, buyers: 0, revenue: 0, regLeads: new Set<string>(), buyerLeads: new Set<string>(), impressions, video3s, thruplays });
    expect(metricsOf([r(1000, 200, 100), r(5000, null, null)])).toMatchObject({ impressions: 6000, hookRate: 20, holdRate: 50 });
  });
});

// ───────────── 2. Concept rounds per industry ─────────────

describe('concept rounds per industry', () => {
  it('every industry × built-in angle × awareness × framework writes three ads that pass every rule, in the industry’s words', () => {
    for (const ind of INDUSTRIES) for (const angle of ruleAngles()) for (const a of AWARENESS) for (const f of FRAMEWORKS) {
      const spec: ConceptSpec = { angle, awareness: a.id, framework: f.id, format: 'talking_head', desire: DESIRES[0].id, audience: angle.audience };
      const ads = templateAds(spec, 3, ind);
      expect(ads, `${ind.id} ${angle.key} ${a.id} ${f.id}`).toHaveLength(3);
      for (const ad of ads) expect(adProblems(ad, [angle.proof_id])).toEqual([]);
      expect(ads.some((ad) => ad.hook.includes(ind.owners) || ad.hook.includes(ind.target) || ad.headline.includes(ind.target) || ad.headline.includes(ind.owners))).toBe(true);
    }
  });

  it('drafts a round tagged with the industry; ads point at the smart route; the spec carries the link', async () => {
    const db = freshDb(); const rt = makeRt(db);
    await expect(draftRound(rt, { industry: 'nope' }, null)).rejects.toThrow(/Unknown industry/);
    const r = await draftRound(rt, { industry: 'dental' }, null);
    expect(r).toMatchObject({ ads: 12, industry: 'dental', link: 'https://apply.test/m?ind=dental' });
    expect(industryLink('https://apply.test/', INDUSTRIES[0])).toBe('https://apply.test/m?ind=medical');
    const round = db.prepare('SELECT label, industry, link, kind FROM ads_concept_rounds').get() as Record<string, string>;
    expect(round).toMatchObject({ industry: 'dental', link: 'https://apply.test/m?ind=dental', kind: 'concepts' });
    expect(round.label).toMatch(/Dental/);
    const hooks = (db.prepare('SELECT hook FROM ads_concept_ads').all() as { hook: string }[]).map((x) => x.hook).join(' ');
    expect(hooks).toMatch(/dental practice/);
    const [p] = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    expect(p.detail).toContain('/m?ind=dental');
    await approveAction(rt, p.id);
    expect((db.prepare('SELECT spec FROM ads_concept_rounds').get() as { spec: string }).spec).toContain('Website URL: https://apply.test/m?ind=dental');
  });

  it('with the write token the paused ads link to the industry lander', async () => {
    const db = freshDb(); const rt = makeRt(db, { META_ADS_WRITE_TOKEN: 'w', ADS_PAGE_ID: '555' });
    const posts: { url: string; body: URLSearchParams }[] = [];
    let k = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      if (init.method === 'POST') { posts.push({ url: String(url), body: init.body! }); return json(200, { id: String(70000 + k++) }); }
      return json(404, {});
    }));
    await draftRound(rt, { industry: 'hvac', adset_id: '801' }, null);
    const [p] = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    expect((await approveAction(rt, p.id)).ok).toBe(true);
    const creative = posts.find((x) => x.url.endsWith('/adcreatives'))!;
    expect(JSON.parse(creative.body.get('object_story_spec')!).link_data.link).toBe('https://apply.test/m?ind=hvac');
    expect(posts.filter((x) => x.url.endsWith('/ads')).every((x) => /HVAC/.test(x.body.get('name')!))).toBe(true);
  });

  it('feeds Claude that industry’s customer language first', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const add = (id: string, body: string, leadInd: string | null) => {
      if (leadInd) db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, status, industry) VALUES (?, ?, 1, 1, 'applied', ?)").run(`L${id}`, `R${id}`, leadInd);
      db.prepare("INSERT INTO research_items (id, source, kind, external_id, body, lead_id, collected_at, updated_at) VALUES (?, 'voc', 'booking', ?, ?, ?, ?, ?)").run(`voc:${id}`, id, body, leadInd ? `L${id}` : null, Number(id), Number(id));
    };
    add('1', 'stuck at the 5-6m range need more locations', 'Dental group');
    add('2', 'my practice needs a second chair', 'dentistry');
    add('3', 'want to buy the dentist down the road', null);
    add('4', 'logistics fleet question', 'Logistics');
    const lang = await loadCustomerLanguage(rt, 10, INDUSTRIES.find((i) => i.id === 'dental'));
    expect(lang.slice(0, 3).sort()).toEqual(['my practice needs a second chair', 'stuck at the 5-6m range need more locations', 'want to buy the dentist down the road'].sort());
    const prompts: string[] = [];
    await draftRound(rt, { industry: 'dental' }, async (_s, user) => { prompts.push(user); throw new Error('offline'); });
    expect(prompts[0]).toMatch(/Industry round: every ad speaks to dental practice owners/);
  });

  it('rolls results up by industry', async () => {
    const db = freshDb(); const now = Date.now(); const rt = makeRt(db);
    await draftRound(rt, { industry: 'dental' }, null, now - 5 * DAY);
    await draftRound(rt, { industry: 'plumbing' }, null, now - 5 * DAY);
    const rows = db.prepare('SELECT a.id, a.utm_content, r.industry FROM ads_concept_ads a JOIN ads_concept_rounds r ON r.id = a.round_id').all() as { id: string; utm_content: string; industry: string }[];
    rows.forEach((a, i) => db.prepare("UPDATE ads_concept_ads SET status = 'launched', meta_ad_id = ? WHERE id = ?").run(String(60000 + i), a.id));
    rows.forEach((_a, i) => db.prepare("INSERT INTO ad_insights (ad_id, day, ad_name, spend, impressions, currency, updated_at) VALUES (?, ?, 'x', 10, 100, 'USD', ?)").run(String(60000 + i), ymd(now - DAY), now));
    const dental = rows.find((r) => r.industry === 'dental')!;
    db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, lt_content, created_at, updated_at) VALUES ('t1', 'ticket_paid', 'live', 'p1', 'L1', ?, 10000, 0, 'usd', ?, ?, ?)").run(now - DAY, dental.utm_content, now, now);
    const v = await conceptsView(rt, now);
    expect(v.byIndustry.map((x) => x.id)).toEqual(['dental', 'plumbing']);
    expect(v.byIndustry[0]).toMatchObject({ label: 'Dental', rounds: 1, spend: 120, buyers: 1, revenue: 100 });
    expect(v.options.industries).toHaveLength(20);
    expect(industryRollup([{ id: 'r', industry: null }], [{ id: 'a', round_id: 'r' }], new Map())[0]).toMatchObject({ id: null, label: 'All industries' });
  });
});

// ───────────── 3. Offer copy value-equation check ─────────────

describe('offer copy check (value equation)', () => {
  it('finds each part, and suggests only lines we may state', () => {
    const all = checkValueEquation('Buy your first competitor with Josh’s team beside you. Every deal is tested at 1.5x. Kickoff happens within 7 days of signing. The deposit is credited in full.');
    expect(all.every((e) => e.present)).toBe(true);
    const none = checkValueEquation('Reserve your place in this intake.');
    expect(none.filter((e) => !e.present).map((e) => e.id)).toEqual(['dream', 'likelihood', 'time', 'effort']);
    const lk = checkValueEquation('Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.').find((e) => e.id === 'likelihood')!;
    expect(lk.found).toEqual(['proof']);
    // A money-back period is a likelihood booster, not a time to the first result.
    expect(checkValueEquation('7-day money-back guarantee').find((e) => e.id === 'time')!.present).toBe(false);
    const sug = suggestionsFor(none, 'engagement');
    expect(sug.map((s) => s.element)).toEqual(['dream', 'likelihood', 'time', 'effort']);
    expect(sug.find((s) => s.element === 'likelihood')!.lines.join(' ')).toMatch(/two acquisitions.*sellers financed 100%/);
    expect(sug.find((s) => s.element === 'likelihood')!.lines[0]).toMatch(/^Signed LOI in 90 days, or we keep working free\. The conditions/);
    for (const line of allFactLines()) expect(auditCopy(line), line).toEqual([]);
    for (const e of ELEMENTS) expect(auditCopy(e.what)).toEqual([]);
    expect(Object.keys(FACT_LINES)).toEqual(['engagement', 'sprint']);
  });

  it('checks every offer surface as it reads now, an edited email in its edited form, and never changes anything', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const r1 = await valueEquationReport(rt);
    const ids = r1.surfaces.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['room_deposit', 'challenge_offer', 'email:live_replay_last', 'email:live_nobuy_questions', 'email:ch_offer_1']));
    expect(r1.surfaces.length).toBeGreaterThanOrEqual(4 + OFFER_EMAILS.length - 3);
    const room = r1.surfaces.find((s) => s.id === 'room_deposit')!;
    expect(room.elements.find((e) => e.id === 'likelihood')!.found).toContain('guarantee');
    expect(room.elements.find((e) => e.id === 'effort')!.present).toBe(true);
    const ch4 = r1.surfaces.find((s) => s.id === 'email:ch_offer_4')!;
    expect(ch4.missing).toBeGreaterThan(0);
    expect(ch4.suggestions.length).toBe(ch4.missing);
    // An owner edit of ch_offer_4 is what gets checked.
    db.prepare("INSERT INTO email_overrides (template, subject, preheader, body, cta_label, cta_href, ps, updated_at) VALUES ('ch_offer_4', 'closing in an hour', 'Last note', ?, '', '', '', 1)")
      .run('Buy your first competitor with Josh’s team beside you. Every deal is tested at 1.5x. Kickoff happens within 7 days of signing. The deposit is credited in full.');
    const { clearOverrideCache } = await import('../src/integrations/email-overrides');
    clearOverrideCache();
    const r2 = await valueEquationReport(rt);
    const ch4b = r2.surfaces.find((s) => s.id === 'email:ch_offer_4')!;
    expect(ch4b).toMatchObject({ edited: true, missing: 0 });
    expect(n(db, "SELECT COUNT(*) AS n FROM email_overrides")).toBe(1); // nothing written by the check
    clearOverrideCache();
  });

  it('checks pasted copy and lists copy-rule issues next to it', () => {
    const r = checkPasted('Reserve your place today!! It might work.', 'sprint');
    expect(r.missing).toBe(4);
    expect(r.suggestions.find((s) => s.element === 'time')!.lines[0]).toMatch(/Seven days/);
    expect(r.copyIssues.map((i) => i.rule).join(' ')).toMatch(/hedge|exclamation/);
  });
});

// ───────────── 4. Halo retargeting map ─────────────

const NOW = Date.now();
function lead(db: DatabaseSync, id: string) {
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, country) VALUES (?, ?, ?, ?, ?, 'Dana', 'Lee', ?, 'applied', 'AU')`).run(id, `R${id}`, NOW, NOW, `v_${id}`, `${id}@owner.co`);
}

describe('halo retargeting map', () => {
  it('plans an audience for every engaged state, and the video audience only when we have ad videos', () => {
    const keys = buildPlan().map((i) => i.key);
    for (const f of ['auto', 'live', 'challenge']) expect(keys).toEqual(expect.arrayContaining([`list_reg_noshow_${f}`, `web_reg_noshow_${f}`, `list_attended_nobuy_${f}`, `web_attended_nobuy_${f}`]));
    for (const d of [1, 2, 3, 4]) { expect(keys).toContain(`list_challenge_day${d}`); expect(keys).not.toContain(`web_challenge_day${d}`); }
    expect(keys).not.toContain('video_ads_watched50');
    const withVideo = buildPlan({ videoIds: ['111', '222', 'bad'] });
    const v = withVideo.find((i) => i.key === 'video_ads_watched50')!;
    expect(v.kind).toBe('video');
    expect(videoRule(v)).toEqual([{ object_id: '111', event_name: 'video_view_50_percent' }, { object_id: '222', event_name: 'video_view_50_percent' }]);
    // Every halo state's audiences exist in the plan.
    const all = new Set(withVideo.map((i) => i.key));
    for (const h of haloStates()) for (const k of h.audiences) expect(all.has(k), `${h.id} → ${k}`).toBe(true);
  });

  it('finds the people in each state from our own tables, leaving clients out', async () => {
    const db = freshDb(); const rt = makeRt(db);
    for (const id of ['came', 'missed', 'future', 'client', 'd1', 'd2']) lead(db, id);
    db.prepare("INSERT INTO live_webinars (id, title, starts_at, tz, created_at, updated_at) VALUES ('ev1', 'Live', ?, 'UTC', 1, 1), ('ev2', 'Later', ?, 'UTC', 1, 1)").run(NOW - DAY, NOW + 5 * DAY);
    const reg = db.prepare('INSERT INTO live_webinar_regs (id, token, event_id, lead_id, joined_at, created_at) VALUES (?, ?, ?, ?, ?, 1)');
    reg.run('r1', 't1', 'ev1', 'came', NOW - DAY);
    reg.run('r2', 't2', 'ev1', 'missed', null);
    reg.run('r3', 't3', 'ev2', 'future', null);
    reg.run('r4', 't4', 'ev1', 'client', NOW - DAY);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('p1', 'r4', 'client', 'deposit', 'paid', 500000, 'usd', 1, 1, 1)").run();
    const ids = async (seg: Parameters<typeof segmentIds>[1]) => [...(await segmentIds(rt, seg)).ids].sort();
    expect(await ids({ type: 'registered_not_attended', funnel: 'live' })).toEqual(['missed']);
    expect(await ids({ type: 'attended_no_offer', funnel: 'live' })).toEqual(['came']);
    db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co1', 'Nov', ?, '18:00', 'UTC', 1, 1)").run(ymd(NOW - 3 * DAY));
    db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, status, created_at) VALUES ('cr1', 'x1', 'co1', 'd1', 'paid', 1), ('cr2', 'x2', 'co1', 'd2', 'paid', 1)").run();
    db.prepare('INSERT INTO challenge_progress (reg_id, day, joined_at, present_at) VALUES (?, ?, ?, ?)').run('cr1', 1, NOW, null);
    db.prepare('INSERT INTO challenge_progress (reg_id, day, joined_at, present_at) VALUES (?, ?, ?, ?)').run('cr1', 2, null, NOW);
    expect(await ids({ type: 'challenge_day', day: 1 })).toEqual(['d1']);
    expect(await ids({ type: 'challenge_day', day: 2 })).toEqual(['d1']);
    expect(await ids({ type: 'challenge_day', day: 3 })).toEqual([]);
    expect(await ids({ type: 'registered_not_attended', funnel: 'challenge' })).toEqual(['d2']);
    expect(await ids({ type: 'attended_no_offer', funnel: 'challenge' })).toEqual(['d1']);
  });

  it('maps each state to a next-step concept whose ads pass every rule; drafting goes through approval', async () => {
    for (const h of haloStates()) {
      const ads = templateAds(haloSpec(h), 3);
      expect(ads.length, h.id).toBe(3);
      for (const ad of ads) expect(adProblems(ad, [h.concept.angle.proof_id])).toEqual([]);
      for (const ad of ads) expect(ad.hook).not.toMatch(/\byou (watched|registered|attended|opened)\b/i);
      expect(auditCopy(h.nextStep)).toEqual([]);
      expect(auditCopy(h.label)).toEqual([]);
    }
    const db = freshDb(); const rt = makeRt(db);
    const rep = await haloReport(rt);
    expect(rep.states.length).toBe(haloStates().length);
    expect(rep.states.find((s) => s.id === 'video50')!.audiences[0].status).toBe('not_in_plan'); // no ad videos yet
    expect(rep.states.find((s) => s.id === 'nobuy_live')!.audiences[0]).toMatchObject({ key: 'list_attended_nobuy_live', status: 'not_created' });
    await expect(draftHalo(rt, 'nope')).rejects.toThrow(/Unknown/);
    const r = await draftHalo(rt, 'nobuy_live');
    expect(r.ads).toBe(3);
    expect(db.prepare('SELECT kind, halo, label FROM ads_concept_rounds').get()).toMatchObject({ kind: 'halo', halo: 'nobuy_live', label: expect.stringMatching(/^Retargeting: Attended the live webinar/) });
    const props = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    expect(props.map((p) => p.kind)).toEqual(['marketing.launch_concepts']);
    expect((await haloReport(rt)).states.find((s) => s.id === 'nobuy_live')!.round).toMatchObject({ status: 'proposed' });
  });

  it('the video audience is created in Meta only after approval, as an ENGAGEMENT audience on our ad videos', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO ad_entities (id, level, name, video_id, updated_at) VALUES ('a1', 'ad', 'v', '424242', 1)").run();
    const calls: { url: string; params: URLSearchParams }[] = [];
    let k = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: URLSearchParams }) => {
      calls.push({ url, params: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(url).split('?')[1] ?? '') });
      return json(200, /\/users/.test(url) ? { num_received: 1 } : { id: `m${++k}` });
    }));
    const rt = makeRt(db, { META_PIXEL_ID: '366', META_ACCESS_TOKEN: 'capi', META_AD_ACCOUNT_ID: '708', META_ADS_WRITE_TOKEN: 'write' });
    const { id } = await proposeCreateAll(rt);
    expect(calls).toHaveLength(0);
    const act = db.prepare('SELECT kind, payload, detail FROM ops_actions WHERE id = ?').get(id) as { kind: string; payload: string; detail: string };
    expect(act.kind).toBe(CREATE_KIND);
    expect(JSON.parse(act.payload).keys).toContain('video_ads_watched50');
    expect(act.detail).toMatch(/video engagement audience/);
    await approveAction(rt, id);
    for (let i = 0; i < 12 && n(db, "SELECT COUNT(*) AS n FROM meta_audiences WHERE status = 'queued'"); i++) await maybeSyncAudiences(rt);
    const vid = calls.find((c) => c.params.get('subtype') === 'ENGAGEMENT')!;
    expect(vid.url).toMatch(/act_708\/customaudiences$/);
    expect(JSON.parse(vid.params.get('rule')!)).toEqual([{ object_id: '424242', event_name: 'video_view_50_percent' }]);
    expect(vid.params.get('prefill')).toBe('1');
    expect(db.prepare("SELECT status FROM meta_audiences WHERE key = 'video_ads_watched50'").get()).toEqual({ status: 'created' });
  });
});
