import { tinyLaunchAdapter } from './tinylaunch.js';
import type { Adapter } from './types.js';

/** Adapters shipped in this build. Presence here is necessary, never sufficient, for coverage. */
export function builtinAdapters(): Map<string, Adapter> {
  const list = [tinyLaunchAdapter()];
  return new Map(list.map((a) => [a.id, a]));
}

export type { Adapter } from './types.js';
