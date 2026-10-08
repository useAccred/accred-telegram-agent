/** A small in-memory limiter, per process. Enough to blunt abuse of one bot instance. */
const hits = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [name, times] of hits) if (times.every((time) => now - time >= windowMs)) hits.delete(name);
  }
  return recent.length > limit;
}
