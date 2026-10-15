import { describe, expect, it } from 'vitest';
import { cleanOverride, defaultEditable, fromOverride, htmlToText, isEditable, textToHtml } from '../src/integrations/email-overrides';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx } from '../src/integrations/templates';
import type { Lead } from '../src/funnel/leads';

const ctx = (x: Partial<TemplateCtx> = {}): TemplateCtx => ({
  lead: { id: 'l1' } as Lead, name: 'Dana', siteName: 'G&L', link: (p) => `LINK(${p})`, bookingUrl: 'https://calendly.com/x', whatsappUrl: null, callTime: 'Friday 16 October at 10:00 am AEDT', ...x,
});

describe('email editor', () => {
  it('shows built-in emails with merge tags, and an unedited round trip reads the same', () => {
    const d = defaultEditable('pc_agenda')!;
    expect(d.subject).toBe('exactly what happens on the call');
    expect(d.body).toContain('{first_name}');
    expect(d.body).toContain('{call_time}');
    expect(d.cta_href).toBe('{link:/breakout}');
    const out = fromOverride({ ...d, preheader: d.preheader, cta_label: d.cta_label, cta_href: d.cta_href, ps: d.ps || null }, ctx());
    expect(out.body.join(' ')).toContain('Dana, here’s how the call works (Friday 16 October at 10:00 am AEDT)');
    expect(out.cta?.href).toBe('LINK(/breakout)');
    const orig = TEMPLATES.pc_agenda(ctx());
    expect(out.subject).toBe(orig.subject);
  });

  it('escapes what the owner types, and only allows safe links', () => {
    expect(textToHtml('**hi** <script>x</script> [go](javascript:alert) [ok](/apply)')).toBe('<b>hi</b> &lt;script&gt;x&lt;/script&gt; go <a href="/apply">ok</a>');
    expect(() => cleanOverride({ subject: 's', body: 'b', cta_label: 'x', cta_href: 'javascript:alert(1)' })).toThrow();
    expect(() => cleanOverride({ subject: '', body: 'b' })).toThrow();
    const o = fromOverride({ subject: 'Hi {first_name} <b>', preheader: null, body: 'Line one\nline two\n\n[Book]({booking_link})', cta_label: 'Go <i>now</i>', cta_href: '{booking_link}', ps: null }, ctx({ name: 'Dana' }));
    expect(o.subject).toBe('Hi Dana b');
    expect(o.body[1]).toBe('<a href="LINK(https://calendly.com/x)">Book</a>');
    expect(o.cta?.label).not.toMatch(/[<>]/); // no markup gets into the button
    expect(o.cta?.href).toBe('LINK(https://calendly.com/x)');
    expect(htmlToText('a<br><b>b</b> <a href="/x">c</a>')).toBe('a\n**b** [c](/x)');
  });

  it('never edits the emails written from each lead’s own answers', () => {
    expect(isEditable('pp_brief')).toBe(false);
    expect(isEditable('resume_link')).toBe(false);
    expect(isEditable('re_1')).toBe(true);
    expect(isEditable('nope')).toBe(false);
  });
});

describe('reactivation', () => {
  it('runs 30 days at 3–5 emails a day, every one a different email, and stops once they come back', () => {
    const seq = SEQUENCES.reactivation;
    expect(seq.steps.length).toBeGreaterThanOrEqual(110);
    expect(new Set(seq.steps.map((s) => s.template)).size).toBe(seq.steps.length);
    const perDay = new Map<number, number>();
    for (const st of seq.steps) { const d = Math.floor(st.offsetMs / 86_400_000); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
    expect([...perDay.keys()].sort((a, b) => a - b)).toEqual([...Array(31).keys()]);
    for (const n of perDay.values()) { expect(n).toBeGreaterThanOrEqual(3); expect(n).toBeLessThanOrEqual(5); }
    // Every send lands between 8am and 7pm of its day.
    for (const st of seq.steps) expect((st.offsetMs % 86_400_000) / 3_600_000).toBeLessThanOrEqual(11);
    expect(seq.steps[seq.steps.length - 1].template).toBe('rc_final');
    const lead = { status: 'booked', reactivated_at: 1000, booked_at: 500, booking_cancelled_at: null, app_completed_at: null } as unknown as Lead;
    expect(seq.stopIf!(lead)).toBe(false);
    expect(seq.stopIf!({ ...lead, booked_at: 2000 })).toBe(true);
    expect(seq.stopIf!({ ...lead, app_completed_at: 2000 })).toBe(true);
    expect(seq.stopIf!({ ...lead, status: 'won' })).toBe(true);
    for (const s of seq.steps) {
      const c = TEMPLATES[s.template](ctx());
      expect(c.body.join(' ')).not.toMatch(/\bfree\b[^.]{0,30}\bcall\b|\bcall\b[^.]{0,15}\bfree\b/i);
    }
  });
});

describe('funding wording', () => {
  it('every email that mentions senior debt or a lender funding the price also names seller rollover', async () => {
    const { buildDossier } = await import('../src/followup/dossier');
    void buildDossier;
    const lead = { id: 'l1', ref_code: 'AB12CD', first_name: 'Sam', tier: 'A', booked_at: 1, call_at: Date.now() + 86400000, app_completed_at: 1, answers: null } as never;
    const c = { lead, name: 'Sam', siteName: 'G&L', link: (p: string) => `https://x.test${p}`, bookingUrl: 'https://cal.test', whatsappUrl: null, callTime: 'Monday 3pm' };
    const missing: string[] = [];
    for (const [k, t] of Object.entries(TEMPLATES)) {
      const e = t(c as never);
      const text = [e.subject, e.preheader, ...e.body, e.ps ?? ''].join(' ').toLowerCase();
      if (/senior debt|seller finance|seller note/.test(text) && /senior debt|lender puts in/.test(text) && !text.includes('seller rollover')) missing.push(k);
    }
    expect(missing).toEqual([]);
  });
});
