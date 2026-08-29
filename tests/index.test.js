import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function memoryStore() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function stub(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

test('track and identify flush Mixpanel-like events', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };
  stub('localStorage', memoryStore());
  stub('sessionStorage', memoryStore());
  stub('location', { href: 'https://app.test/signup?utm_source=docs', pathname: '/signup', search: '?utm_source=docs' });
  stub('document', { referrer: 'https://example.com', title: 'Signup', addEventListener() {}, visibilityState: 'visible' });
  stub('window', { addEventListener() {}, fetch: fetchImpl });
  stub('navigator', { userAgent: 'Mozilla/5.0 Chrome' });
  stub('history', { pushState() {}, replaceState() {} });
  stub('fetch', fetchImpl);
  stub('XMLHttpRequest', function XHR() {});
  globalThis.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  stub('performance', { now: () => 1, getEntriesByType: () => [] });
  stub('PerformanceObserver', undefined);

  const here = path.dirname(new URL(import.meta.url).pathname);
  const { loggify } = await import(pathToFileURL(path.join(here, '../dist/index.js')).href);
  loggify.init({
    apiKey: 'test-key',
    endpoint: 'http://collector.test',
    service: 'web',
    environment: 'test',
    autocapture: false,
    flushIntervalMs: 60_000,
  });
  loggify.track('Signed Up', { plan: 'pro' });
  loggify.identify('user_1', { email: 'ada@example.com' });
  await loggify.flush();
  const ingest = posts.find((post) => String(post.url).endsWith('/v1/ingest'));
  assert.ok(ingest);
  assert.ok(ingest.body.events.some((event) => event.event === 'Signed Up'));
  assert.ok(ingest.body.events.some((event) => event.event === '$identify' && event.userId === 'user_1'));
  loggify.shutdown();
});
