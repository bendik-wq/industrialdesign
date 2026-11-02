/**
 * The honest-version rules for ad and script copy, enforced in code (on top of auditCopy / auditAd):
 *  - no fake authority: no "experts say", "as seen on", outlet names, "#1", "world's leading";
 *  - the common belief a podcast-clip ad argues against is never pinned on a named person;
 *  - no invented value or results: every number comes from an approved proof point, the 1.5x test, the $1M+
 *    audience or a revenue band, or the line is labelled illustrative;
 *  - no fake scarcity or deadlines ("spots left", "closing soon", "only N seats");
 *  - funding is never described without seller rollover; the call is never free; no guarantee of results.
 */
import { BANDS, PROOF } from '../research/analyze';
import { answerProblems } from '../webinar/assistant';
import { auditAd } from './angles';

export interface Issue { rule: string; excerpt: string }

const FAKE_AUTHORITY = /\b(experts?|studies|a study|research|scientists|economists|analysts) (say|says|show|shows|prove|proves|agree|found)\b|\bas seen (on|in)\b|\bfeatured (on|in)\b|\b(forbes|harvard|wall street journal|wsj|bloomberg|cnbc|inc\.? ?5000|new york times|shark tank)\b|#1\b|\bnumber one\b|\bworld'?s (leading|best|top|#1)\b|\b(top|leading) experts?\b|\baward[- ]winning\b/i;
const SCARCITY = /\b(only \d+ (spots?|seats?|places?|left)|spots? (are )?left|seats? (are )?left|closing (soon|tonight)|last chance|limited time|ends (tonight|today|soon)|hurry|before it'?s gone|selling out)\b/i;
const NAMED_PERSON = /\b([A-Z][a-z]+ [A-Z][a-z]+) (says|said|claims|claimed|thinks|teaches|tells|told|believes|argues)\b/g;
const INVENTED_VALUE = /\b(a|an) \$[\d,.]+k? value\b|\bworth \$[\d,.]+k?\b|\bvalued at \$[\d,.]+/i;

/** Numbers a line may carry without the illustrative label. */
export function allowedNumbers(proofIds: string[] = []) {
  const proof = PROOF.filter((p) => proofIds.includes(p.id) || p.id === 'seller_financed').map((p) => p.text).join(' ');
  return `${proof} 1.5x $1m+ ${BANDS.join(' ')}`.toLowerCase().replace(/\s/g, '');
}

/** Problems with one piece of copy under the honest-version rules (empty when it passes). */
export function honestProblems(text: string, proofIds: string[] = []): Issue[] {
  const out: Issue[] = [];
  const t = String(text ?? '');
  const ex = (m: string) => m.slice(0, 80);
  const fa = t.match(FAKE_AUTHORITY); if (fa) out.push({ rule: 'no fake authority', excerpt: ex(fa[0]) });
  const sc = t.match(SCARCITY); if (sc) out.push({ rule: 'no fake scarcity or deadline', excerpt: ex(sc[0]) });
  for (const m of t.matchAll(NAMED_PERSON)) if (m[1] !== 'Josh Li') { out.push({ rule: 'argue against a belief, never a named person', excerpt: ex(m[0]) }); break; }
  const iv = t.match(INVENTED_VALUE); if (iv && !/illustrative/i.test(t)) out.push({ rule: 'no invented value', excerpt: ex(iv[0]) });
  // Numbers: per line, from the proof / 1.5x / $1M+ / bands, or the line says "illustrative".
  const allowed = allowedNumbers(proofIds);
  for (const line of t.split(/\n+/)) {
    if (/illustrative/i.test(line)) continue;
    const nums = line.match(/\$?\d[\d,.]*\s?(%|x|k|m|million)?/gi) ?? [];
    const bad = nums.find((n) => !allowed.includes(n.toLowerCase().replace(/\s/g, '').replace(/[.,]+$/, '')));
    if (bad) { out.push({ rule: `unsupported number "${bad.trim()}" (use a proof point or label it illustrative)`, excerpt: ex(line) }); break; }
  }
  for (const p of answerProblems(t)) out.push({ rule: p, excerpt: ex(t) });
  return out;
}

/** auditAd (auditCopy + ad rules) plus the honest-version rules. */
export function auditHonest(text: string, proofIds: string[] = []): Issue[] {
  return [...auditAd(text), ...honestProblems(text, proofIds)];
}
