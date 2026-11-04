import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, F, Glass, Kicker, Words, ease, useIn } from './ui';

const H = (size: number): React.CSSProperties => ({
  fontFamily: F.display, fontWeight: 800, fontSize: size, lineHeight: 1.02, letterSpacing: '-0.035em', color: C.ink,
});

// ---------- generic kinetic text ----------
export type Line = { t: string; size?: number; at?: number; dim?: boolean; weight?: number };
export const Lines: React.FC<{ kicker?: string; lines: Line[]; center?: boolean }> = ({ kicker, lines, center = true }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 26, alignItems: center ? 'center' : 'flex-start', textAlign: center ? 'center' : 'left' }}>
    {kicker && <Kicker>{kicker}</Kicker>}
    {lines.map((l, i) => (
      <div key={i} style={{ ...H(l.size ?? 104), fontWeight: l.weight ?? 800, color: l.dim ? C.dim : C.ink, maxWidth: 1620 }}>
        <Words text={l.t} delay={l.at ?? i * 24} />
      </div>
    ))}
  </div>
);

// ---------- 1. objections the customer hears ----------
const QUOTES = [
  { q: 'Vi tenker på det.', who: 'Kunde · tirsdag 14:12', x: -520, y: -250, r: -2 },
  { q: 'Send meg et tilbud, så ser vi.', who: 'Kunde · onsdag 09:40', x: 430, y: -170, r: 1.5 },
  { q: 'Det var litt dyrere enn vi trodde.', who: 'Kunde · torsdag 16:05', x: -400, y: 120, r: 1 },
  { q: 'Ring meg etter sommeren.', who: 'Kunde · fredag 11:31', x: 480, y: 230, r: -1.5 },
];
export const Objections: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      {QUOTES.map((q, i) => {
        const d = 6 + i * 26;
        const p = useIn(d, 20);
        const stamp = ease(f, d + 22, d + 30);
        return (
          <div key={i} style={{ position: 'absolute', transform: `translate(${q.x}px, ${q.y + (1 - p) * 60}px) rotate(${q.r}deg) scale(${0.9 + p * 0.1})`, opacity: p }}>
            <Glass style={{ padding: '30px 40px', minWidth: 560 }}>
              <div style={{ fontFamily: F.mono, fontSize: 20, color: C.faint, letterSpacing: '.08em', marginBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 30 }}>
                <span>{q.who}</span>
                <span style={{ color: C.orange, opacity: stamp, transform: `scale(${1.6 - stamp * 0.6})`, border: `1.5px solid ${C.orange}`, borderRadius: 8, padding: '2px 10px' }}>TAPT</span>
              </div>
              <div style={{ ...H(54), fontWeight: 700 }}>«{q.q}»</div>
            </Glass>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ---------- 2. two types of companies ----------
export const TwoTypes: React.FC = () => {
  const f = useCurrentFrame();
  const col = (title: string, items: [string, number][], hot: boolean, d: number) => {
    const p = useIn(d);
    return (
      <Glass glow={hot ? C.orange : undefined} style={{ flex: 1, opacity: p, transform: `translateY(${(1 - p) * 40}px)`, padding: '40px 46px' }}>
        <div style={{ fontFamily: F.mono, fontSize: 22, letterSpacing: '.14em', color: hot ? C.orange : C.faint, textTransform: 'uppercase' }}>{hot ? 'Type 2' : 'Type 1'}</div>
        <div style={{ ...H(66), marginTop: 10, color: hot ? C.ink : C.dim }}>{title}</div>
        <div style={{ marginTop: 30, display: 'grid', gap: 16 }}>
          {items.map(([k, v], i) => {
            const n = Math.round(ease(f, d + 16 + i * 8, d + 60 + i * 8) * v);
            return (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.line}`, paddingTop: 16, fontFamily: F.display, fontSize: 36, fontWeight: 600, color: hot ? C.ink : C.dim }}>
                <span>{k}</span><span style={{ fontFamily: F.mono, color: hot ? C.orange : C.faint }}>{n.toLocaleString('nb-NO')}</span>
              </div>
            );
          })}
        </div>
      </Glass>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 50 }}>
      <div style={H(96)}><Words text="Det finnes *to* *typer* bedrifter." /></div>
      <div style={{ display: 'flex', gap: 40 }}>
        {col('Kjøper synlighet', [['Klikk', 48210], ['Visninger', 912400], ['Nye kunder', 3]], false, 30)}
        {col('Kjøper kunder', [['Salgsmøter', 64], ['Tilbud sendt', 41], ['Nye kunder', 23]], true, 60)}
      </div>
    </div>
  );
};

// ---------- 4. the leak ----------
const FUNNEL: [string, number][] = [['Henvendelser', 100], ['Svar samme dag', 62], ['Tilbud sendt', 31], ['Fulgt opp', 9], ['Nye kunder', 4]];
export const Leak: React.FC = () => {
  const f = useCurrentFrame();
  const big = useIn(150);
  return (
    <div style={{ display: 'flex', gap: 90, alignItems: 'center' }}>
      <div style={{ flex: 1.25, display: 'grid', gap: 22 }}>
        <Kicker>Hvor salget lekker</Kicker>
        {FUNNEL.map(([k, v], i) => {
          const d = 14 + i * 18;
          const w = ease(f, d, d + 26) * v;
          const lost = i > 0 ? FUNNEL[i - 1][1] - v : 0;
          return (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: '300px 1fr 110px', alignItems: 'center', gap: 24 }}>
              <div style={{ fontFamily: F.display, fontSize: 32, fontWeight: 600, color: C.dim }}>{k}</div>
              <div style={{ height: 54, background: 'rgba(255,255,255,.05)', borderRadius: 12, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, width: `${w}%`, borderRadius: 12, background: i === FUNNEL.length - 1 ? C.orange : `linear-gradient(90deg, ${C.blue}, ${C.blue}aa)` }} />
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 30, color: C.ink, textAlign: 'right' }}>
                {Math.round(w)}{lost > 0 && <div style={{ fontSize: 20, color: C.orange, opacity: ease(f, d + 20, d + 30) }}>−{lost}</div>}
              </div>
            </div>
          );
        })}
        <div style={{ fontFamily: F.mono, fontSize: 18, color: C.faint, letterSpacing: '.08em' }}>TYPISK MØNSTER · ILLUSTRASJON</div>
      </div>
      <div style={{ flex: 1, opacity: big, transform: `translateY(${(1 - big) * 30}px)` }}>
        <div style={{ ...H(230), color: C.orange, letterSpacing: '-0.06em' }}>96</div>
        <div style={{ ...H(64), marginTop: 6 }}>av 100 henvendelser blir aldri kunder.</div>
      </div>
    </div>
  );
};

// ---------- 5. the gap in the middle ----------
export const Gap: React.FC = () => {
  const f = useCurrentFrame();
  const a = useIn(10), b = useIn(26), g = useIn(60);
  const pulse = 0.6 + 0.4 * Math.sin(f / 9);
  const box = (k: string, t: string, p: number) => (
    <Glass style={{ width: 520, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, padding: '40px 44px' }}>
      <div style={{ fontFamily: F.mono, fontSize: 22, letterSpacing: '.14em', color: C.faint }}>{k}</div>
      <div style={{ ...H(56), marginTop: 12 }}>{t}</div>
    </Glass>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      {box('BYRÅET', 'Måles på klikk.', a)}
      <div style={{ flex: 1, height: 340, margin: '0 30px', position: 'relative', opacity: g }}>
        <div style={{ position: 'absolute', inset: '0 20px', borderRadius: 30, border: `2px dashed ${C.orange}`, background: `radial-gradient(closest-side, ${C.orange}${Math.round(pulse * 60).toString(16).padStart(2, '0')}, transparent)` }} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <div style={{ fontFamily: F.mono, fontSize: 22, letterSpacing: '.16em', color: C.orange }}>INGEN EIER DETTE</div>
          <div style={{ ...H(48), marginTop: 14 }}>Her forsvinner<br />pengene.</div>
        </div>
      </div>
      {box('SELGERNE', 'Måles på avtaler.', b)}
    </div>
  );
};

// ---------- 6. three options ----------
export const Options: React.FC = () => {
  const f = useCurrentFrame();
  const opts = [
    { n: '01', t: 'Mer markedsføring', s: 'Mer vann i en bøtte med hull.', ok: false },
    { n: '02', t: 'Kurs for selgerne', s: 'Glemt to uker etter kurset.', ok: false },
    { n: '03', t: 'Vi selger for deg først', s: 'Teamet ser det skje. Så gjør de det selv.', ok: true },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 46 }}>
      <Kicker>Du har tre valg</Kicker>
      <div style={{ display: 'flex', gap: 34 }}>
        {opts.map((o, i) => {
          const d = 10 + i * 30;
          const p = useIn(d);
          const strike = o.ok ? 0 : ease(f, 120 + i * 12, 136 + i * 12);
          const lit = o.ok ? ease(f, 150, 170) : 0;
          return (
            <Glass key={o.n} glow={lit > 0.5 ? C.orange : undefined} style={{ flex: 1, minHeight: 360, opacity: p * (1 - strike * 0.55), transform: `translateY(${(1 - p) * 40 - lit * 14}px) scale(${1 + lit * 0.04})`, padding: '40px 40px', position: 'relative' }}>
              <div style={{ fontFamily: F.mono, fontSize: 24, color: o.ok ? C.orange : C.faint }}>{o.n}</div>
              <div style={{ ...H(58), marginTop: 18, position: 'relative', display: 'inline-block' }}>
                {o.t}
                <div style={{ position: 'absolute', left: 0, top: '55%', height: 6, borderRadius: 3, width: `${strike * 100}%`, background: C.orange }} />
              </div>
              <div style={{ fontFamily: F.display, fontSize: 30, color: C.dim, marginTop: 20, fontWeight: 500, lineHeight: 1.3 }}>{o.s}</div>
            </Glass>
          );
        })}
      </div>
    </div>
  );
};

// ---------- 6b. 90-day track ----------
export const Track: React.FC = () => {
  const f = useCurrentFrame();
  const phases = [
    { from: 0, to: 2, t: 'Diagnose', s: 'Vi finner lekkasjene.', c: 'rgba(255,255,255,.14)', ink: C.ink },
    { from: 2, to: 6, t: 'Vi tar møtene', s: 'Teamet ditt sitter med og lytter.', c: C.orange, ink: C.onAccent },
    { from: 6, to: 12, t: 'Teamet tar over', s: 'Vi coacher hver uke til de lukker like godt.', c: C.blue, ink: C.onAccent },
  ];
  const W = 1600;
  const head = ease(f, 20, 260);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 50 }}>
      <Kicker>Salgsmotoren · 90 dager</Kicker>
      <div style={{ position: 'relative', width: W, height: 380 }}>
        {Array.from({ length: 13 }).map((_, i) => (
          <div key={i} style={{ position: 'absolute', left: (i / 12) * W, top: 0, bottom: 40, width: 1, background: C.line }}>
            <div style={{ position: 'absolute', bottom: -40, left: -30, width: 60, textAlign: 'center', fontFamily: F.mono, fontSize: 18, color: C.faint }}>{i % 2 === 0 ? `U${i}` : ''}</div>
          </div>
        ))}
        {phases.map((p, i) => {
          const d = 30 + i * 60;
          const w = ease(f, d, d + 34);
          return (
            <div key={p.t} style={{ position: 'absolute', left: (p.from / 12) * W + 6, top: 20 + i * 108, width: ((p.to - p.from) / 12) * W * w - 12, height: 92, borderRadius: 18, background: p.c, overflow: 'hidden', boxShadow: i ? `0 20px 60px -20px ${p.c}` : 'none' }}>
              <div style={{ padding: '14px 22px', whiteSpace: 'nowrap', opacity: ease(f, d + 20, d + 34) }}>
                <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 34, color: p.ink, letterSpacing: '-0.02em' }}>{p.t}</div>
                <div style={{ fontFamily: F.display, fontWeight: 500, fontSize: 22, color: p.ink, opacity: 0.75 }}>{p.s}</div>
              </div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: head * W, top: -10, bottom: 30, width: 2, background: C.ink, boxShadow: `0 0 20px ${C.ink}` }} />
      </div>
    </div>
  );
};

// ---------- 6c. what's included ----------
export const Stack: React.FC = () => {
  const items = [
    ['Innleid salgsdirektør i 90 dager', 'Vi tar de viktigste møtene selv'],
    ['Markedsføring som fyller kalenderen', 'Annonser, landingsside og oppfølging'],
    ['Salgsprosess og samtaleguider', 'Fra første kontakt til signert avtale'],
    ['Ukentlig trening av teamet', 'På ekte samtaler, ikke rollespill'],
    ['Dashbord for hver krone', 'Du ser hva markedsføringen gir tilbake'],
  ];
  return (
    <div style={{ display: 'flex', gap: 80, alignItems: 'center' }}>
      <div style={{ flex: 0.8 }}>
        <Kicker>Dette får du</Kicker>
        <div style={{ ...H(110), marginTop: 22 }}><Words text="Salgsmotoren." delay={6} /></div>
        <div style={{ fontFamily: F.display, fontSize: 34, color: C.dim, marginTop: 20, lineHeight: 1.3, fontWeight: 500 }}><Words text="Markedsføring, salg og trening. Ett team, ett mål: flere kunder." delay={20} per={2} /></div>
      </div>
      <div style={{ flex: 1.2, display: 'grid', gap: 16 }}>
        {items.map(([t, s], i) => {
          const p = useIn(30 + i * 16);
          return (
            <Glass key={t} style={{ display: 'flex', gap: 24, alignItems: 'center', padding: '22px 30px', opacity: p, transform: `translateX(${(1 - p) * 60}px)` }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: C.orange, display: 'grid', placeItems: 'center', color: C.onAccent, fontWeight: 800, fontSize: 26, fontFamily: F.display, flex: 'none' }}>✓</div>
              <div>
                <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 34, color: C.ink, letterSpacing: '-0.02em' }}>{t}</div>
                <div style={{ fontFamily: F.mono, fontSize: 20, color: C.dim, marginTop: 4 }}>{s}</div>
              </div>
            </Glass>
          );
        })}
      </div>
    </div>
  );
};

// ---------- 7. guarantee ----------
export const Guarantee: React.FC = () => {
  const f = useCurrentFrame();
  const p = useIn(4, 30);
  const ring = 'SKRIFTLIG GARANTI · VILKÅR PÅ SIDEN · SKRIFTLIG GARANTI · ';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 110 }}>
      <div style={{ width: 460, height: 460, position: 'relative', flex: 'none', opacity: p, transform: `scale(${0.8 + p * 0.2})` }}>
        <svg viewBox="0 0 460 460" style={{ position: 'absolute', inset: 0, transform: `rotate(${f * 0.4}deg)` }}>
          <defs><path id="rp" d="M230 230 m-185 0 a185 185 0 1 1 370 0 a185 185 0 1 1 -370 0" /></defs>
          <text style={{ fontFamily: F.mono, fontSize: 25, letterSpacing: 5.4, fill: C.dim }}><textPath href="#rp">{ring}</textPath></text>
        </svg>
        <div style={{ position: 'absolute', inset: 80, borderRadius: '50%', background: `radial-gradient(circle at 30% 25%, ${C.orange}, ${C.accentDeep})`, display: 'grid', placeItems: 'center', boxShadow: `0 40px 120px -20px ${C.orange}` }}>
          <div style={{ textAlign: 'center', color: C.onAccent }}>
            <div style={{ ...H(130), color: C.onAccent, letterSpacing: '-0.06em' }}>90</div>
            <div style={{ fontFamily: F.mono, fontSize: 24, letterSpacing: '.18em', marginTop: -6 }}>DAGER</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <Kicker>Garantien</Kicker>
        <div style={{ ...H(84), marginTop: 22 }}><Words text="*30* *kvalifiserte* *møter* på 90 dager." delay={14} /></div>
        <div style={{ ...H(84), marginTop: 10, color: C.dim }}><Words text="Ellers jobber vi gratis til du har dem." delay={60} /></div>
      </div>
    </div>
  );
};

// ---------- 8. next step ----------
export const NextStep: React.FC = () => {
  const steps = [
    ['Regn ut lekkasjen', 'Kalkulatoren rett under videoen'],
    ['Se om du kvalifiserer', '4 spørsmål, så 30 min med en av oss'],
    ['Få de tre største lekkasjene', 'Oversikten er din, uansett'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 44 }}>
      <Kicker>Neste steg</Kicker>
      <div style={{ display: 'flex', gap: 30 }}>
        {steps.map(([t, s], i) => {
          const p = useIn(12 + i * 22);
          return (
            <Glass key={t} glow={i === 1 ? C.orange : undefined} style={{ flex: 1, minHeight: 300, opacity: p, transform: `translateY(${(1 - p) * 40}px)`, padding: '40px 40px' }}>
              <div style={{ ...H(110), color: i === 1 ? C.orange : C.faint, letterSpacing: '-0.06em' }}>{i + 1}</div>
              <div style={{ ...H(48), marginTop: 18 }}>{t}</div>
              <div style={{ fontFamily: F.mono, fontSize: 22, color: C.dim, marginTop: 14 }}>{s}</div>
            </Glass>
          );
        })}
      </div>
    </div>
  );
};

export const EndCard: React.FC<{ Mark: React.FC<{ size?: number }> }> = ({ Mark }) => {
  const f = useCurrentFrame();
  const p = useIn(4, 30);
  const b = useIn(30);
  const arrow = Math.sin(f / 7) * 8;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40, opacity: p }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, transform: `scale(${0.9 + p * 0.1})` }}>
        <Mark size={110} />
        <div style={{ fontFamily: F.display, fontSize: 86, fontWeight: 600, color: C.ink, letterSpacing: '-0.04em' }}>media<b style={{ fontWeight: 800 }}>partneren</b></div>
      </div>
      <div style={{ opacity: b, transform: `translateY(${(1 - b) * 20}px)`, background: C.ink, color: C.bg, fontFamily: F.display, fontWeight: 800, fontSize: 44, padding: '26px 52px', borderRadius: 999, display: 'flex', gap: 20, alignItems: 'center', letterSpacing: '-0.02em' }}>
        Se om du kvalifiserer <span style={{ display: 'inline-block', transform: `translateY(${arrow}px)` }}>↓</span>
      </div>
      <div style={{ fontFamily: F.mono, fontSize: 22, color: C.faint, letterSpacing: '.12em', opacity: b }}>30 SALGSMØTER PÅ 90 DAGER · SKRIFTLIG GARANTERT</div>
    </div>
  );
};

