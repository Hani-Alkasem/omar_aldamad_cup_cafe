import type { Tone } from '@/components/ui';

export const TIER: Record<string, { label: string; tone: Tone }> = {
  tier0: { label: 'Tier 0 · critical', tone: 'bad' },
  tier1: { label: 'Tier 1', tone: 'warn' },
  tier2: { label: 'Tier 2', tone: 'muted' },
  tier3: { label: 'Tier 3', tone: 'muted' },
};
