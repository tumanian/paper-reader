'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../abuse-guard.js');

test('extractClientIp prefers cf-connecting-ip', () => {
  assert.equal(
    guard.extractClientIp({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }, null),
    '1.2.3.4',
  );
});

test('extractClientIp parses the first x-forwarded-for entry', () => {
  assert.equal(
    guard.extractClientIp({ 'x-forwarded-for': ' 10.0.0.1 , 10.0.0.2 ' }, null),
    '10.0.0.1',
  );
});

test('extractClientIp falls back to socket remoteAddress', () => {
  assert.equal(guard.extractClientIp({}, '127.0.0.1'), '127.0.0.1');
});

test('classifyTaskBucket maps cheap tasks and defaults unknown to expensive', () => {
  assert.equal(guard.classifyTaskBucket('classify-selection'), 'cheap');
  assert.equal(guard.classifyTaskBucket('citation-preview-claude'), 'expensive');
  assert.equal(guard.classifyTaskBucket(undefined), 'expensive');
  assert.equal(guard.classifyTaskBucket('chat'), 'expensive');
});

test('decideRateLimit blocks when minute count exceeds limit', () => {
  const r = guard.decideRateLimit({
    counts: { minIp: 11, dayIp: 1 },
    limits: { perMin: 10, perDay: 100 },
    ttls: { minIp: 42 },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSeconds, 42);
});

test('decideRateLimit uses the stricter authenticated dimension', () => {
  const r = guard.decideRateLimit({
    counts: { minIp: 1, minUser: 21, dayIp: 1, dayUser: 1 },
    limits: { perMin: 20, perDay: 300 },
    ttls: { minUser: 17 },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSeconds, 17);
});

test('parseGuardPipeline reads kill flag and counter TTLs', () => {
  const keys = guard.rateLimitKeys({ bucket: 'expensive', ip: '1.2.3.4', userId: null });
  const { pipeline, meta } = guard.buildGuardPipeline(keys);
  assert.ok(pipeline.length > 1);
  const results = [
    { result: '1' },
    { result: 3 }, { result: 1 }, { result: 55 },
    { result: 5 }, { result: 1 }, { result: 4000 },
  ];
  const parsed = guard.parseGuardPipeline(results, meta);
  assert.equal(parsed.killed, false);
  assert.equal(parsed.counts.minIp, 3);
  assert.equal(parsed.counts.dayIp, 5);
  assert.equal(parsed.ttls.minIp, 55);
});

test('parseGuardPipeline marks killed when chat_enabled is 0', () => {
  const keys = guard.rateLimitKeys({ bucket: 'expensive', ip: 'x' });
  const { meta } = guard.buildGuardPipeline(keys);
  const parsed = guard.parseGuardPipeline([{ result: '0' }], meta);
  assert.equal(parsed.killed, true);
});
