import type { WsInbound } from './types';

export function parseInbound(raw: string): WsInbound | null {
  if (raw.length > 128 * 1024) return null; // basic abuse guard
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.type !== 'string') return null;
  return obj as WsInbound;
}

