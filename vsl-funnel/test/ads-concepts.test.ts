import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { RULE_ANGLES } from '../src/research/analyze';
import { approveAction, getAction, hasHandler, listActions } from '../src/ops/actions';
import { runAutopilot } from '../src/marketing/autopilot';
import {
  AWARENESS, type AngleSrc, type ConceptSpec, DESIRES, FORMATS, FRAMEWORKS, adProblems, conceptsView, draftHookVariants, draftRound, editConceptAd, judgeRound,
  maybeDraftWinnerHooks, metricsOf, planRound, primaryOf, ruleAngles, signature, specFrom, templateAds, templateBody, writeConceptAds,
} from '../src/marketing/concepts';
import { honestProblems } from '../src/marketing/honest';
import { type DayMoney, merFloor, merGuard, merSummary, summarize } from '../src/marketing/mer';
import { SCRIPT_FORMATS, draftHookPack, draftScript, editScript, scriptProblems, scriptSeconds, scriptsView, templateHookPack, templateScript } from '../src/marketing/scripts';
import type { Complete } from '../src/marketing/angles';

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
const BASE: Record<string, string> = { META_ADS_TOKEN: 'read_tok', META_AD_ACCOUNT_ID: '123456', ADS_TARGET_CPA_TICKET: '150', SITE_NAME: 'G&L' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...BASE, ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const allSpecs = (): ConceptSpec[] => {
  const out: ConceptSpec[] = [];
  for (const angle of ruleAngles()) for (const a of AWARENESS) for (const f of FRAMEWORKS) for (const fm of ['static', 'double_hook'] as const) {
    out.push({ angle, awareness: a.id, framework: f.id, format: fm, desire: DESIRES[(out.length) % DESIRES.length].id, audience: angle.audience });
  }
  return out;
};

// ───────────── 1. The honest-version rules ─────────────

describe('honest-version rules', () => {
  it('catches fake authority, scarcity, named people, invented value and unsupported numbers', () => {
    const rules = (t: string) => honestProblems(t).map((i) => i.rule).join(' | ');
    expect(rules('Experts say this is the best way to buy a business.')).toMatch(/fake authority/);
    expect(rules('As seen on Forbes.')).toMatch(/fake authority/);
    expect(rules('Only 3 spots left this month.')).toMatch(/scarcity/);
    expect(rules('Grant Cardone says you need cash to buy.')).toMatch(/named person/);
    expect(rules('Josh Li says the order matters.')).toBe('');
    expect(rules('A bonus worth $5,000 comes with it.')).toMatch(/invented value|unsupported number/);
    expect(rules('Our clients close 7 deals a year.')).toMatch(/unsupported number "7/);
    expect(rules('Fund it with commercial debt and seller finance.')).toMatch(/rollover/);
  });

  it('lets through approved proof, the 1.5x test, $1M+ and labelled illustrative numbers', () => {
    expect(honestProblems('Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.')).toEqual([]);
    expect(honestProblems('Every deal is tested at 1.5x debt service coverage, for owners at $1M+ revenue.')).toEqual([]);
    expect(honestProblems('Illustrative: a group trades at 8-12x against 3-5x for one business.')).toEqual([]);
    expect(honestProblems('One radiology deal of $5.5M was over $5M.', ['radiology'])).toEqual([]);
    expect(honestProblems('One radiology deal of $5.5M was over $5M.')).not.toEqual([]);
  });
});

// ───────────── 2. Templates and planning ─────────────

describe('concept templates', () => {
  it('every built-in angle × awareness × framework writes three ads that pass every rule', () => {
    for (const s of allSpecs()) {
      const ads = templateAds(s);
      expect(ads, `${s.angle.key} ${s.awareness} ${s.framework} ${s.format}`).toHaveLength(3);
      expect(new Set(ads.map((a) => a.hook)).size).toBe(3);
      for (const a of ads) {
        expect(adProblems(a, [s.angle.proof_id]), primaryOf(a)).toEqual([]);
        expect(a.body).toBe(templateBody(s)); // one body per concept: the ads differ in the hook
      }
    }
  });

  it('plans four concepts that differ on purpose and skips combinations already tested', () => {
    const plan = planRound(ruleAngles(), 0);
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((p) => p.angle.hook)).size).toBe(4);
    expect(new Set(plan.map((p) => p.awareness)).size).toBe(4);
    expect(new Set(plan.map((p) => p.format)).size).toBe(4);
    for (const p of plan) { expect(DESIRES.map((d) => d.id)).toContain(p.desire); expect(FORMATS.map((d) => d.id)).toContain(p.format); }
    expect(plan.find((p) => p.format === 'podcast_clip')?.framework ?? 'contrarian').toBe('contrarian');
    const tested = new Set(plan.map((p) => signature(p)));
    const again = planRound(ruleAngles(), 0, tested);
    for (const p of again) expect(tested.has(signature(p))).toBe(false);
    // The next round rotates the variables.
    expect(planRound(ruleAngles(), 1).map((p) => p.awareness)).not.toEqual(plan.map((p) => p.awareness));
  });

  it('validates an owner-edited concept against the lists', () => {
    const angles = ruleAngles();
    expect(specFrom({ angle_ref: 'k:funding', desire: 'be_the_buyer', awareness: 'solution', format: 'podcast_clip', framework: 'contrarian', audience: 'HNW Capital Deployer' }, angles))
      .toMatchObject({ audience: 'HNW Capital Deployer', angle: { key: 'funding' } });
    expect(specFrom({ angle_ref: 'k:funding', desire: 'get_rich', awareness: 'solution', format: 'static', framework: 'pas' }, angles)).toBeNull();
    expect(specFrom({ angle_ref: 'k:nope', desire: 'be_the_buyer', awareness: 'solution', format: 'static', framework: 'pas' }, angles)).toBeNull();
  });

  it('Claude ads are audited; what breaks a rule twice is replaced by the template ad', async () => {
    const specs = planRound(ruleAngles(), 0);
    const good = { hook: 'Most owners never price what buying a competitor would add.', body: 'Commercial debt, seller finance and seller rollover carry the price.\nSee how the structure works on the page.', headline: 'Buy the competitor down the road', description: 'Tested at 1.5x debt service coverage.' };
    const bad = { ...good, hook: 'Experts say only 3 spots left!' };
    let calls = 0;
    const complete: Complete = async (_s, user) => {
      calls++;
      expect(user).toContain('never quote them');
      return JSON.stringify({ concepts: specs.map((_c, i) => ({ idx: i + 1, ads: [good, i === 0 ? bad : good, good] })) });
    };
    const r = await writeConceptAds(specs, { complete, language: ['I want more locations without more hours'] });
    expect(calls).toBe(2); // one retry with the broken rules listed
    expect(r.origin).toBe('ai');
    expect(r.replaced).toBe(1);
    expect(r.ads[0][1].hook).not.toContain('Experts');
    for (const [i, list] of r.ads.entries()) { expect(list).toHaveLength(3); for (const a of list) expect(adProblems(a, [specs[i].angle.proof_id])).toEqual([]); }
  });
});

// ───────────── 3. Rounds: draft, approve (spec or paused ads), results, winners, hook variants ─────────────

describe('concept rounds end to end', () => {
  it('drafts 4 × 3 tagged ads and queues one launch proposal; without the write token approval gives a spec', async () => {
    const db = freshDb(); const rt = makeRt(db);
    db.prepare("INSERT INTO research_angles (id, origin, hook, promise, proof_id, audience, revenue_band, belief, evidence, status, fingerprint, created_at, updated_at) VALUES ('ra1', 'rules', ?, ?, 'seller_financed', 'One-Business Ceiling', 'All $1M+', ?, '[]', 'approved', 'fp1', 1, 1)")
      .run(RULE_ANGLES.acquire.hook, RULE_ANGLES.acquire.promise, RULE_ANGLES.acquire.belief);
    const r = await draftRound(rt, {}, null);
    expect(r).toMatchObject({ ads: 12, origin: 'template' });
    const ads = db.prepare('SELECT utm_content, status, hook, body FROM ads_concept_ads ORDER BY utm_content').all() as { utm_content: string; status: string; hook: string; body: string }[];
    expect(ads).toHaveLength(12);
    expect(new Set(ads.map((a) => a.utm_content)).size).toBe(12);
    expect(ads.every((a) => /^cr[0-9a-z]{6}-c[1-4]a[1-3]$/.test(a.utm_content) && a.status === 'proposed')).toBe(true);
    const concepts = db.prepare('SELECT angle_id, desire, awareness, format, audience, framework FROM ads_concepts ORDER BY idx').all() as Record<string, string>[];
    expect(concepts[0].angle_id).toBe('ra1'); // Research's approved angle goes first
    const props = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    expect(props).toHaveLength(1);
    expect(props[0].kind).toBe('marketing.launch_concepts');
    expect(props[0].detail).toContain('No write token');
    const res = await approveAction(rt, props[0].id);
    expect(res).toMatchObject({ ok: true, summary: expect.stringMatching(/Spec ready to paste.*no write token/) });
    const round = db.prepare('SELECT status, spec FROM ads_concept_rounds').get() as { status: string; spec: string };
    expect(round.status).toBe('exported');
    expect(round.spec).toContain('utm_content=cr');
    expect((db.prepare("SELECT COUNT(*) AS n FROM ads_concept_ads WHERE status = 'exported'").get() as { n: number }).n).toBe(12);
    expect((db.prepare("SELECT status FROM research_angles WHERE id = 'ra1'").get() as { status: string }).status).toBe('testing');
    expect(hasHandler('marketing.launch_concepts')).toBe(true);
  });

  it('with the write token, a Page id and an ad set: one paused ad per draft, Meta ids stored', async () => {
    const db = freshDb(); const rt = makeRt(db, { META_ADS_WRITE_TOKEN: 'w', ADS_PAGE_ID: '555' });
    const posts: { url: string; body: URLSearchParams }[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      if (init.method === 'POST') { posts.push({ url: String(url), body: init.body! }); return json(200, { id: String(70000 + n++) }); }
      return json(404, {});
    }));
    await draftRound(rt, { adset_id: '801' }, null);
    const [p] = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    const res = await approveAction(rt, p.id);
    expect(res).toMatchObject({ ok: true, summary: expect.stringMatching(/12 paused ads created in ad set 801/) });
    const adCalls = posts.filter((x) => x.url.endsWith('/ads'));
    expect(adCalls).toHaveLength(12);
    expect(adCalls.every((x) => x.body.get('status') === 'PAUSED')).toBe(true);
    const creative = posts.find((x) => x.url.endsWith('/adcreatives'))!;
    expect(creative.body.get('url_tags')).toMatch(/utm_content=cr[0-9a-z]{6}-c[1-4]a[1-3]$/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ads_concept_ads WHERE status = 'launched' AND meta_ad_id IS NOT NULL").get() as { n: number }).n).toBe(12);
  });

  it('rolls up spend, registrants, buyers and ROAS by concept and by variable; picks the winner; drafts hook-only variants', async () => {
    const db = freshDb(); const now = Date.now(); const rt = makeRt(db, { ADS_TARGET_CPA_TICKET: '' });
    await draftRound(rt, {}, null, now - 10 * DAY);
    const ads = db.prepare('SELECT a.id, a.utm_content, c.idx AS cidx, a.idx FROM ads_concept_ads a JOIN ads_concepts c ON c.id = a.concept_id ORDER BY c.idx, a.idx').all() as { id: string; utm_content: string; cidx: number; idx: number }[];
    // Launched: Meta ids on every ad.
    ads.forEach((a, i) => db.prepare("UPDATE ads_concept_ads SET status = 'launched', meta_ad_id = ? WHERE id = ?").run(String(80000 + i), a.id));
    const ins = db.prepare("INSERT INTO ad_insights (ad_id, day, ad_name, spend, impressions, currency, updated_at) VALUES (?, ?, ?, ?, 1000, 'USD', ?)");
    ads.forEach((a, i) => ins.run(String(80000 + i), ymd(now - 2 * DAY), `x (${a.utm_content})`, 50, now)); // 150 per concept
    const conv = db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, lt_content, lt_ad_id, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?)");
    const c1a1 = ads.find((a) => a.cidx === 1 && a.idx === 1)!, c1a2 = ads.find((a) => a.cidx === 1 && a.idx === 2)!, c2a1 = ads.find((a) => a.cidx === 2 && a.idx === 1)!;
    // Concept 1: 4 registrants, 2 buyers of a $100 ticket (one refunded in full), and one $5,000 deposit.
    for (const k of [1, 2, 3, 4]) conv.run(`r${k}`, 'registered', `g${k}`, `L${k}`, now - DAY, 0, 0, k <= 2 ? c1a1.utm_content : c1a2.utm_content, null, now, now);
    conv.run('t1', 'ticket_paid', 'p1', 'L1', now - DAY, 10000, 0, c1a1.utm_content, null, now, now);
    conv.run('t2', 'ticket_paid', 'p2', 'L3', now - DAY, 10000, 10000, null, '80001', now, now); // matched by Meta ad id, refunded
    conv.run('d1', 'deposit_paid', 'p3', 'L2', now - DAY, 500000, 0, c1a1.utm_content, null, now, now);
    // Concept 2: one registrant through the apply funnel's leads table.
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, utm_content) VALUES ('LA', 'RA1', ?, ?, 'Ana', 'a@example.com', 'applied', ?)").run(now - DAY, now, c2a1.utm_content);

    const v = await conceptsView(rt, now);
    const round = v.rounds[0];
    const c1 = round.concepts.find((c) => c.idx === 1)!, c2 = round.concepts.find((c) => c.idx === 2)!;
    expect(c1.metrics).toMatchObject({ spend: 150, registrants: 4, buyers: 2, revenue: 5100, costPerRegistrant: 37.5, costPerBuyer: 75, roas: 34 });
    expect(c2.metrics).toMatchObject({ spend: 150, registrants: 1, buyers: 0, revenue: 0, roas: 0 });
    expect(c1.verdict).toBe('winner');
    expect(c1.verdict_by).toBe('auto');
    expect(c1.ads[0].results).toMatchObject({ registrants: 2, buyers: 2, revenue: 5100 });
    // By variable: the winning concept's desire leads its table.
    expect(v.byVariable.desire[0]).toMatchObject({ value: c1.desire, revenue: 5100 });
    expect(Object.keys(v.byVariable).sort()).toEqual(['angle', 'audience', 'awareness', 'desire', 'format', 'framework']);

    // The autopilot drafts hook-only variants for the auto winner (once), queued for approval.
    const h = await maybeDraftWinnerHooks(rt, now, null);
    expect(h).not.toBeNull();
    expect(h!.parentAdId).toBe(c1a1.id); // the concept's best ad
    const variants = db.prepare("SELECT hook, body, headline, parent_ad_id, utm_content, status FROM ads_concept_ads WHERE kind = 'hook_variant'").all() as Record<string, string>[];
    const parent = db.prepare('SELECT hook, body, headline FROM ads_concept_ads WHERE id = ?').get(c1a1.id) as Record<string, string>;
    const usedHooks = (db.prepare("SELECT hook FROM ads_concept_ads WHERE concept_id = (SELECT concept_id FROM ads_concept_ads WHERE id = ?)").all(c1a1.id) as { hook: string }[]).map((x) => x.hook);
    expect(variants).toHaveLength(3);
    for (const x of variants) {
      expect(x.body).toBe(parent.body);
      expect(x.headline).toBe(parent.headline);
      expect(usedHooks).not.toContain(x.hook);
      expect(x.utm_content.startsWith(`${c1a1.utm_content}-h`)).toBe(true);
      expect(x.status).toBe('proposed');
    }
    expect(await maybeDraftWinnerHooks(rt, now, null)).toBeNull();
    const props = await listActions(rt, { dept: 'marketing', status: 'proposed' });
    expect(props.some((p) => p.kind === 'marketing.launch_concepts' && /hook variants/.test(p.summary))).toBe(true);
    // Hook variant results are matched by their own tag.
    const v2 = await conceptsView(rt, now);
    expect(v2.rounds.find((r) => r.kind === 'hooks')!.concepts[0].parent_id).toBe(c1.id);
  });

  it('judges a round on targets: no winner above the target cost, losers by spend', () => {
    const m = (spend: number, registrants: number, buyers: number, revenue: number) => metricsOf([{ spend, registrants, buyers, revenue, regLeads: new Set(Array.from({ length: registrants }, (_x, i) => `r${i}`)), buyerLeads: new Set(Array.from({ length: buyers }, (_x, i) => `b${i}`)) }]);
    const rows = [{ id: 'a', m: m(400, 2, 1, 100) }, { id: 'b', m: m(300, 0, 0, 0) }, { id: 'c', m: m(100, 5, 0, 0) }];
    const v = judgeRound(rows, { cpl: 30, ticket: 150, winnerMin: 3, loserSpend: 300 });
    expect(v.get('c')).toMatchObject({ verdict: 'winner' }); // 20 per registrant, under 30
    expect(v.get('a')).toBeUndefined();                       // 200 per registrant, over the 30 target
    expect(v.get('b')).toMatchObject({ verdict: 'loser' });
    expect(judgeRound(rows, { cpl: 10, ticket: 150, winnerMin: 3, loserSpend: 300 }).get('c')).toBeUndefined();
  });

  it('the owner can edit a draft (audited) and mark a winner; hook variants work by hand too', async () => {
    const db = freshDb(); const rt = makeRt(db);
    await draftRound(rt, {}, null);
    const ad = db.prepare('SELECT id FROM ads_concept_ads LIMIT 1').get() as { id: string };
    await expect(editConceptAd(rt, ad.id, { hook: 'Only 2 spots left, hurry.' })).rejects.toThrow(/scarcity|unsupported number/);
    await editConceptAd(rt, ad.id, { hook: 'Somebody is going to buy the competitor down the road. It can be you.' });
    const concept = db.prepare('SELECT concept_id FROM ads_concept_ads WHERE id = ?').get(ad.id) as { concept_id: string };
    const r = await draftHookVariants(rt, concept.concept_id, null);
    expect(r.hooks.length).toBeGreaterThan(0);
    const action = await getAction(rt, r.actionId);
    expect(action!.kind).toBe('marketing.launch_concepts');
  });
});

// ───────────── 4. Blended MER and the floor ─────────────

describe('blended MER', () => {
  it('summarises a window against the one before it (pure)', () => {
    const days: DayMoney[] = [];
    for (let i = 0; i < 14; i++) days.push({ day: ymd(Date.parse('2026-11-14T00:00:00Z') - i * DAY), revenue: i < 7 ? 300 : 100, spend: 100 });
    const w = summarize(days, '2026-11-14', 7);
    expect(w).toMatchObject({ revenue: 2100, spend: 700, mer: 3, prev: { revenue: 700, spend: 700, mer: 1 }, change: 200 });
  });

  it('reads revenue net of refunds and spend without double counting campaign and ad rows', async () => {
    const db = freshDb(); const now = Date.now(); const rt = makeRt(db);
    const conv = db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, created_at, updated_at) VALUES (?, ?, 'live', ?, 'L', ?, ?, ?, 'usd', 1, 1)");
    conv.run('a', 'ticket_paid', 'p1', now - DAY, 10000, 0);
    conv.run('b', 'deposit_paid', 'p2', now - 2 * DAY, 500000, 0);
    conv.run('c', 'ticket_paid', 'p3', now - 3 * DAY, 10000, 10000);     // refunded
    conv.run('d', 'registered', 'p4', now - DAY, 0, 0);
    conv.run('e', 'ticket_paid', 'p5', now - 10 * DAY, 20000, 0);       // previous 7-day window
    // Day 1: campaign rows exist (used); day 2: only ad rows (used); day 10: campaign rows.
    db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, spend, currency, updated_at) VALUES ('meta', 'c1', ?, 1000, 'USD', 1)").run(ymd(now - DAY));
    db.prepare("INSERT INTO ad_insights (ad_id, day, spend, currency, updated_at) VALUES ('a1', ?, 999, 'USD', 1)").run(ymd(now - DAY));
    db.prepare("INSERT INTO ad_insights (ad_id, day, spend, currency, updated_at) VALUES ('a1', ?, 1600, 'USD', 1)").run(ymd(now - 2 * DAY));
    db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, spend, currency, updated_at) VALUES ('meta', 'c1', ?, 400, 'USD', 1)").run(ymd(now - 10 * DAY));
    const s = await merSummary(rt, now);
    expect(s.w7).toMatchObject({ revenue: 5100, spend: 2600, mer: 1.96, prev: { revenue: 200, spend: 400, mer: 0.5 } });
    expect(s.w30).toMatchObject({ revenue: 5300, spend: 3000, mer: 1.77 });
    expect(s.series).toHaveLength(30);
    expect(s.series[s.series.length - 1].mer7).toBe(1.96);
  });

  it('the floor: blank is off; under it scaling is held with the reason; pauses still run', async () => {
    expect(merFloor({ ADS_MER_FLOOR: '' })).toBeNull();
    expect(merFloor({ ADS_MER_FLOOR: '1.5' })).toBe(1.5);
    expect(merGuard(null, { revenue: 0, spend: 100, mer: 0 }).holdScaling).toBe(false);
    const g = merGuard(1.5, { revenue: 840, spend: 1000, mer: 0.84 }, true, 'usd');
    expect(g.holdScaling).toBe(true);
    expect(g.reason).toMatch(/0\.84.*USD 840 revenue net of refunds ÷ USD 1,000 ad spend.*floor of 1\.5/);
    expect(merGuard(1.5, { revenue: 2000, spend: 1000, mer: 2 }).holdScaling).toBe(false);
    expect(merGuard(1.5, { revenue: 0, spend: 0, mer: null }).holdScaling).toBe(false);

    // The autopilot: a winner and a loser; with the floor above MER, no duplicate and no budget move.
    const seed = (db: DatabaseSync, now: number) => {
      const ins = db.prepare("INSERT INTO ad_insights (ad_id, day, adset_id, campaign_id, ad_name, spend, impressions, reach, frequency, link_clicks, currency, updated_at) VALUES (?, ?, ?, '701', ?, ?, 5000, 2500, 2, 70, 'USD', ?)");
      for (let i = 0; i < 7; i++) { ins.run('9001', ymd(now - i * DAY), '801', 'Loser ad', 60, now); ins.run('9002', ymd(now - i * DAY), '802', 'Winner ad', 45, now); }
      const ent = db.prepare("INSERT INTO ad_entities (id, level, name, status, effective_status, campaign_id, adset_id, daily_budget, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'ACTIVE', '701', ?, ?, ?)");
      ent.run('9001', 'ad', 'Loser ad', '801', null, now); ent.run('9002', 'ad', 'Winner ad', '802', null, now);
      ent.run('801', 'adset', 'Broad', '801', 10000, now); ent.run('802', 'adset', 'Owners 1M+', '802', 5000, now);
      const lead = db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band, utm_content) VALUES (?, ?, ?, ?, 'Dana', ?, 'applied', '3m-10m', 'Winner ad')");
      for (const i of [1, 2, 3]) {
        lead.run(`lw${i}`, `RW${i}`, now - i * DAY, now, `w${i}@example.com`);
        db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at, paid_at) VALUES (?, 'r', ?, 'seat', 'paid', 10000, 'usd', ?, ?, ?)").run(`p${i}`, `lw${i}`, now, now, now);
        db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, created_at, updated_at) VALUES (?, 'ticket_paid', 'auto', ?, ?, ?, 10000, 0, 'usd', 1, 1)").run(`c${i}`, `p${i}`, `lw${i}`, now - i * DAY);
      }
    };
    const now = Date.now();
    const held = freshDb(); seed(held, now);
    const rtHeld = makeRt(held, { ADS_MER_FLOOR: '1.5' }); // MER = 300 / 735 = 0.41
    const r = await runAutopilot(rtHeld, now);
    expect(r.held).toMatch(/under the floor of 1\.5/);
    const kinds = (await listActions(rtHeld, { dept: 'marketing', status: 'proposed' })).map((p) => p.kind);
    expect(kinds).toEqual(['marketing.pause_ad']);
    const log = await listActions(rtHeld, { dept: 'marketing', status: 'done' });
    expect(log.find((x) => x.kind === 'marketing.mer_hold')!.detail).toMatch(/won't propose duplicating winners/);
    await runAutopilot(rtHeld, now + 3600_000);
    expect((await listActions(rtHeld, { dept: 'marketing', status: 'done' })).filter((x) => x.kind === 'marketing.mer_hold')).toHaveLength(1); // once a day

    const free = freshDb(); seed(free, now);
    const r2 = await runAutopilot(makeRt(free, { ADS_MER_FLOOR: '' }), now);
    expect(r2.held).toBeNull();
    expect((await listActions(makeRt(free), { dept: 'marketing', status: 'proposed' })).map((p) => p.kind).sort()).toEqual(['marketing.duplicate_ad', 'marketing.pause_ad', 'marketing.shift_budget']);
  });
});

// ───────────── 5. Video scripts and hook packs ─────────────

describe('video scripts and hook packs', () => {
  it('every format × built-in angle passes the rules, with five swappable hooks and 20 to 75 seconds spoken', () => {
    for (const a of ruleAngles()) for (const f of SCRIPT_FORMATS) {
      const s = templateScript(a, f.id);
      expect(scriptProblems(s, [a.proof_id, 'radiology']), `${a.key} ${f.id}`).toEqual([]);
      expect(s.hooks).toHaveLength(5);
      expect(new Set(s.hooks).size).toBe(5);
      expect(s.body.length).toBeGreaterThanOrEqual(3);
      const sec = scriptSeconds(s);
      expect(sec, `${a.key} ${f.id}`).toBeGreaterThanOrEqual(20);
      expect(sec, `${a.key} ${f.id}`).toBeLessThanOrEqual(75);
    }
  });

  it('podcast clip argues against a common belief on screen, never a person; the mini-VSL labels its numbers', () => {
    const a = ruleAngles().find((x) => x.key === 'funding')! as AngleSrc;
    const pod = templateScript(a, 'podcast_clip');
    expect(pod.body[0].screen).toMatch(/^Common advice: "/);
    expect(pod.notes).toMatch(/never attributed to a person/);
    const vsl = templateScript(a, 'cost_of_waiting');
    for (const b of vsl.body) if (/\d/.test(b.say.replace(/1\.5x|\$1M\+/g, ''))) expect(b.say).toMatch(/illustrative/i);
    const dbl = templateScript(a, 'double_hook');
    expect(dbl.hooks[0].split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(2);
  });

  it('stores scripts and hook packs; a swapped-in hook is audited', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const s = await draftScript(rt, { format: 'mechanism', angle_ref: 'k:valuation' }, null);
    expect(s.origin).toBe('template');
    await expect(draftScript(rt, { format: 'nope' }, null)).rejects.toThrow(/format/);
    const pack = await draftHookPack(rt, { angle_ref: 'k:funding' });
    expect(pack.hooks.length).toBeGreaterThanOrEqual(8);
    expect(new Set(pack.hooks.map((h) => h.style)).size).toBeGreaterThanOrEqual(5);
    await expect(editScript(rt, s.id, { hooks: ['Studies show 9 out of 10 owners fail.'] })).rejects.toThrow(/authority|number/);
    await editScript(rt, s.id, { hooks: [pack.hooks[0].text, ...s.hooks], status: 'recorded' });
    const v = await scriptsView(rt);
    expect(v.scripts[0].hooks[0]).toBe(pack.hooks[0].text);
    expect(v.scripts[0].status).toBe('recorded');
    expect(v.scripts[0].text).toContain(`HOOK: ${pack.hooks[0].text}`);
    expect(v.hooks.length).toBe(pack.hooks.length);
    expect(templateHookPack(ruleAngles()[0]).every((h) => !honestProblems(h.text, ['seller_financed', 'radiology']).length)).toBe(true);
  });

  it('a Claude script that breaks a rule falls back to the template', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const complete: Complete = async () => JSON.stringify({ hooks: ['Experts say this works.'], body: [{ beat: 'a', say: 'Grant Cardone says you need cash.', screen: '' }, { beat: 'b', say: 'x', screen: '' }, { beat: 'c', say: 'y', screen: '' }] });
    const s = await draftScript(rt, { format: 'podcast_clip', angle_ref: 'k:funding' }, complete);
    expect(s.origin).toBe('template');
    expect(s.hooks.join(' ')).not.toContain('Experts');
  });
});
