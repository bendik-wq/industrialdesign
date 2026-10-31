import type { Runtime } from '../app';
export interface DepositConfig { amount: number; currency: string; label: string; cap: number | null; guarantee: { headline: string; body: string; conditions: string[]; url: string } }
export function depositConfig(_rt: Runtime): DepositConfig { return { amount: 5000, currency: 'USD', label: '$5,000', cap: null, guarantee: { headline: 'Signed LOI in 90 days, or we keep working free', body: '', conditions: [], url: '/guarantee' } }; }
export async function startDeposit(_rt: Runtime, _o: { leadId: string; source: 'live' | 'challenge'; refId: string; regToken?: string | null; oneClick?: boolean; returnUrl: string }): Promise<{ url?: string; paid?: boolean; error?: string }> { return { error: 'stub' }; }
export function guaranteeHtml(_rt: Runtime): string { return ''; }
