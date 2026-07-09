'use strict';

// Pure abuse-guard helpers for /api/chat. Networked orchestration (Upstash pipeline,
// Supabase token verify) lives in handler.js; this module is unit-testable with
// no I/O.

const EXPENSIVE_TASKS = new Set(['citation-preview-claude']);

const CHEAP_TASKS = new Set([
  'classify-selection',
  'summarize',
  'citation-match',
  'citation-preview',
  'citation-detect',
  'citation-format-detect',
  'bibliography-extract',
]);

const DEFAULT_LIMITS = {
  expensive: {
    anon: { perMin: 10, perDay: 100 },
    auth: { perMin: 20, perDay: 300 },
  },
  cheap: {
    anon: { perMin: 60, perDay: 1000 },
    auth: { perMin: 200, perDay: 2000 },
  },
};

function pad2(n) { return String(n).padStart(2, '0'); }

function minuteStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}

function dayStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function extractClientIp(headers, socketRemote) {
  const h = headers || {};
  const cf = h['cf-connecting-ip'] || h['CF-Connecting-IP'];
  if (cf && String(cf).trim()) return String(cf).trim();

  const xff = h['x-forwarded-for'] || h['X-Forwarded-For'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }

  if (socketRemote && String(socketRemote).trim()) return String(socketRemote).trim();
  return null;
}

function parseBearerToken(authorization) {
  if (!authorization || typeof authorization !== 'string') return null;
  const m = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

function classifyTaskBucket(task) {
  const t = task || 'chat';
  if (EXPENSIVE_TASKS.has(t)) return 'expensive';
  if (CHEAP_TASKS.has(t)) return 'cheap';
  return 'expensive';
}

function limitsForBucket(bucket, authenticated) {
  const b = DEFAULT_LIMITS[bucket] || DEFAULT_LIMITS.expensive;
  const tier = authenticated ? b.auth : b.anon;
  const envPrefix = bucket === 'cheap' ? 'RATE_LIMIT_CHEAP' : 'RATE_LIMIT_EXPENSIVE';
  const scope = authenticated ? 'AUTH' : 'ANON';
  const perMin = Number(process.env[`${envPrefix}_${scope}_PER_MIN`]) || tier.perMin;
  const perDay = Number(process.env[`${envPrefix}_${scope}_PER_DAY`]) || tier.perDay;
  return { perMin, perDay };
}

function rateLimitKeys({ bucket, ip, userId, now = new Date() }) {
  const m = minuteStamp(now);
  const d = dayStamp(now);
  const scope = ip || 'unknown';
  const keys = {
    minIp: `rl:${bucket}:ip:${scope}:m:${m}`,
    dayIp: `rl:${bucket}:ip:${scope}:d:${d}`,
  };
  if (userId) {
    keys.minUser = `rl:${bucket}:user:${userId}:m:${m}`;
    keys.dayUser = `rl:${bucket}:user:${userId}:d:${d}`;
  }
  return keys;
}

function buildGuardPipeline(keys) {
  const pipeline = [['GET', 'chat_enabled']];
  const meta = [{ kind: 'kill' }];

  const addKey = (key, ttl, field) => {
    pipeline.push(['INCR', key], ['EXPIRE', key, String(ttl), 'NX'], ['TTL', key]);
    meta.push({ kind: 'counter', field, ttlKind: ttl === 60 ? 'min' : 'day' });
  };

  addKey(keys.minIp, 60, 'minIp');
  addKey(keys.dayIp, 86400, 'dayIp');
  if (keys.minUser) addKey(keys.minUser, 60, 'minUser');
  if (keys.dayUser) addKey(keys.dayUser, 86400, 'dayUser');

  return { pipeline, meta };
}

function parseGuardPipeline(results, meta) {
  const out = {
    killed: false,
    counts: {},
    ttls: {},
    storeError: false,
  };
  if (!Array.isArray(results)) {
    out.storeError = true;
    return out;
  }

  let idx = 0;
  for (const item of meta) {
    if (item.kind === 'kill') {
      const raw = results[idx++]?.result;
      out.killed = raw === '0' || raw === 0;
      continue;
    }
    const incr = results[idx++]?.result;
    idx++; // EXPIRE
    const ttl = results[idx++]?.result;
    const count = Number(incr);
    if (!Number.isFinite(count)) {
      out.storeError = true;
      continue;
    }
    out.counts[item.field] = count;
    const ttlNum = Number(ttl);
    if (Number.isFinite(ttlNum) && ttlNum > 0) {
      out.ttls[item.field] = ttlNum;
    }
  }
  return out;
}

function decideRateLimit({ counts, limits, ttls }) {
  const minCount = Math.max(counts.minIp || 0, counts.minUser || 0);
  const dayCount = Math.max(counts.dayIp || 0, counts.dayUser || 0);

  if (minCount > limits.perMin) {
    const retry = Math.max(1, ttls.minIp || ttls.minUser || 60);
    return { allowed: false, retryAfterSeconds: retry };
  }
  if (dayCount > limits.perDay) {
    const retry = Math.max(1, ttls.dayIp || ttls.dayUser || 3600);
    return { allowed: false, retryAfterSeconds: retry };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function kvRestConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/$/, ''), token };
}

module.exports = {
  DEFAULT_LIMITS,
  extractClientIp,
  parseBearerToken,
  classifyTaskBucket,
  limitsForBucket,
  rateLimitKeys,
  buildGuardPipeline,
  parseGuardPipeline,
  decideRateLimit,
  kvRestConfig,
  minuteStamp,
  dayStamp,
};
