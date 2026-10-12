import { describe, expect, it } from 'vitest';
import { qualifyCalendly, revenueBand } from '../src/sales/qualify';
import { sector } from '../src/admin/insights';

const form = (o: Record<string, string>) => Object.entries(o).map(([q, a]) => ({ q, a }));
const REV = 'What stage of business are you at? (annual revenue)';
const INV = 'Are you prepared to invest in a partnership with Grøsfjeld & Li if it means you can achieve your goals?';
const BUD = 'Select your ideal budget range for coaching and advisory services (USD)';

describe('Calendly qualification', () => {
  it('reads Calendly revenue bands', () => {
    expect(revenueBand('$1M to $5M')).toBe('1m-5m');
    expect(revenueBand('$5M to $20M')).toBe('5m-20m');
    expect(revenueBand('$20M+')).toBe('20m+');
    expect(revenueBand('$100K to $1M')).toBe('100k-1m');
    expect(revenueBand('$0 to $100K')).toBe('<100k');
  });
  it('A = $1M+ owner who is willing to invest', () => {
    const q = qualifyCalendly(form({ [REV]: '$1M to $5M', [INV]: 'Yes', 'What are you looking for help with?': 'Buying companies\nGetting financing' }));
    expect(q.tier).toBe('A');
    expect(q.flags).toContain('Owns a $1M+ business');
  });
  it('caps big businesses that won’t invest at B', () => {
    expect(qualifyCalendly(form({ [REV]: '$20M+', [INV]: 'No', 'What are you looking for help with?': 'Networking' })).tier).toBe('B');
    expect(qualifyCalendly(form({ [REV]: '$5M to $20M', [BUD]: 'I am not prepared to invest in coaching and/or my success' })).tier).toBe('B');
  });
  it('C = pre-revenue', () => {
    expect(qualifyCalendly(form({ [REV]: '$0 to $100K', [INV]: 'Yes' })).tier).toBe('C');
  });
  it('groups free-text industries', () => {
    expect(sector('clinics podiatry')).toBe('Healthcare');
    expect(sector('Single Family Office ')).toBe('Finance & investing');
    expect(sector('Construction Services M&A Roll Up')).toBe('Construction, trades & field services');
  });
});
