import type { InkStroke } from './ink';

/** Pauses between strokes longer than this (seconds) are cut short in a replay. */
const MAX_GAP = 0.25;

export interface TimelineEntry {
  /** Replay time (seconds) at which the stroke starts. */
  start: number;
  /** Its drawing time, as recorded. */
  duration: number;
}

/**
 * Lays strokes out in replay time: each takes the time it was drawn in, in order, and the pauses between
 * them keep their length up to MAX_GAP — the rhythm of the drawing without the thinking breaks.
 */
export function inkTimeline(strokes: readonly InkStroke[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let clock = 0;
  let prevEnd: number | null = null;
  for (const s of strokes) {
    const first = s.samples[0].t;
    const last = s.samples[s.samples.length - 1].t;
    if (prevEnd !== null) clock += Math.min(Math.max(first - prevEnd, 0), MAX_GAP);
    out.push({ start: clock, duration: Math.max(last - first, 0) });
    clock += Math.max(last - first, 0);
    prevEnd = last;
  }
  return out;
}

/**
 * What the replay shows at time `t`: how many strokes are finished, and the visible part of the one being
 * drawn (its samples up to that moment), if any.
 */
export function inkReplayAt(
  strokes: readonly InkStroke[],
  timeline: readonly TimelineEntry[],
  t: number,
): { done: number; partial: InkStroke | null } {
  let done = 0;
  while (done < strokes.length && t >= timeline[done].start + timeline[done].duration) done++;
  if (done >= strokes.length) return { done, partial: null };
  const e = timeline[done];
  if (t < e.start) return { done, partial: null };
  const s = strokes[done];
  const t0 = s.samples[0].t;
  const visible = s.samples.filter((p) => p.t - t0 <= t - e.start);
  return { done, partial: { pen: s.pen, samples: visible.length ? visible : [s.samples[0]] } };
}

/** Total replay length, seconds. */
export function inkTimelineLength(timeline: readonly TimelineEntry[]): number {
  const last = timeline[timeline.length - 1];
  return last ? last.start + last.duration : 0;
}
