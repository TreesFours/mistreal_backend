/**
 * Abuse-prevention safety valve for DOMAIN_CONFIGS AI flows (Architectural
 * Render today, future domains later) — NOT a per-user quota. Deliberately
 * generous (env-tunable, defaults far above any plausible legitimate usage)
 * so a genuine heavy Pro user never notices it; it exists only to blunt a
 * small number of devices hammering the app's own Gemini key through these
 * flows. In-process/in-memory by design — if this backend ever runs as
 * multiple instances behind a load balancer, each instance tracks its own
 * window (an abuser gets roughly N× the limit, not unlimited) — acceptable
 * for a soft abuse valve, not acceptable if this were a real billing quota.
 */
const WINDOW_MS = parseInt(process.env.DOMAIN_AI_RATE_LIMIT_WINDOW_MS || '3600000', 10); // 1 hour
const MAX_PER_WINDOW = parseInt(process.env.DOMAIN_AI_RATE_LIMIT_MAX || '40', 10);

const hits = new Map<string, number[]>();

export const checkDomainRateLimit = (deviceId?: string): string | null => {
    if (!deviceId) return null; // nothing to key on — the addon gate upstream already requires one
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const recent = (hits.get(deviceId) || []).filter((t) => t > windowStart);
    if (recent.length >= MAX_PER_WINDOW) {
        return 'Too many AI render requests in a short period — please wait a bit and try again.';
    }
    recent.push(now);
    hits.set(deviceId, recent);
    return null;
};
