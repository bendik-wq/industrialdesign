import type { Guide } from '../types';
import { STRUCTURE_GUIDES } from './structures';
import { DEAL_GUIDES } from './deals';
import { INDUSTRY_GUIDES_A } from './industries-a';
import { INDUSTRY_GUIDES_B } from './industries-b';

/** Every guide, in hub order. */
export const GUIDES: Guide[] = [...STRUCTURE_GUIDES, ...DEAL_GUIDES, ...INDUSTRY_GUIDES_A, ...INDUSTRY_GUIDES_B];
