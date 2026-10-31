import type { Runtime } from '../app';
export interface StreamSetup { ready: boolean; reason: string | null; accountId: string | null; customerCode: string | null }
export function streamSetup(_rt: Runtime): StreamSetup { return { ready: false, reason: 'stub', accountId: null, customerCode: null }; }
export interface Playback { mode: 'stream' | 'link' | 'none'; hls: string | null; whep: string | null; isLive: boolean; replayHls: string | null; joinUrl: string | null }
export async function playbackFor(_rt: Runtime, _key: string, fallbackJoinUrl?: string | null): Promise<Playback> { return { mode: fallbackJoinUrl ? 'link' : 'none', hls: null, whep: null, isLive: false, replayHls: null, joinUrl: fallbackJoinUrl ?? null }; }
