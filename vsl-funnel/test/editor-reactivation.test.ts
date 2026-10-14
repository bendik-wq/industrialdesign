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
  it('is 6 emails over 3 weeks that stop once they come back', () => {
    const seq = SEQUENCES.reactivation;
    expect(seq.steps.map((s) => s.template)).toEqual(['re_1', 're_2', 're_3', 're_4', 're_5', 're_6']);
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
