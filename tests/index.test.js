import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'path';

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

async function loadSdk(fetchImpl) {
  stub('localStorage', memoryStore());
  stub('sessionStorage', memoryStore());
  stub('location', {
    href: 'https://app.test/signup?utm_source=docs',
    pathname: '/signup',
    search: '?utm_source=docs',
  });
  stub('document', {
    referrer: 'https://example.com',
    title: 'Signup',
    addEventListener() {},
    visibilityState: 'visible',
  });
  stub('window', { addEventListener() {}, fetch: fetchImpl });
  stub('navigator', { userAgent: 'Mozilla/5.0 Chrome' });
  stub('history', { pushState() {}, replaceState() {} });
  stub('fetch', fetchImpl);
  stub('XMLHttpRequest', function XHR() {});
  globalThis.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  stub('performance', { now: () => 1, getEntriesByType: () => [] });
  stub('PerformanceObserver', undefined);

  const here = path.dirname(new URL(import.meta.url).pathname);
  const mod = await import(pathToFileURL(path.join(here, '../dist/index.js')).href);
  const client = new mod.LoggifyBrowser();
  client.init({
    apiKey: 'test-key',
    endpoint: 'http://collector.test',
    service: 'web',
    environment: 'test',
    autocapture: false,
    flushIntervalMs: 60_000,
  });
  return client;
}

test('track and identify flush Mixpanel-like events', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };
  const loggify = await loadSdk(fetchImpl);
  loggify.track('Signed Up', { plan: 'pro' });
  loggify.identify('user_1', { email: 'ada@example.com' });
  await loggify.flush();
  const ingest = posts.find((post) => String(post.url).endsWith('/v1/ingest'));
  assert.ok(ingest);
  assert.ok(ingest.body.events.some((event) => event.event === 'Signed Up'));
  assert.ok(ingest.body.events.some((event) => event.event === '$identify' && event.userId === 'user_1'));
  loggify.shutdown();
});

test('super properties merge, setOnce skips existing, duration and people snapshot on track', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };
  const loggify = await loadSdk(fetchImpl);
  loggify.register({ app: 'web' });
  loggify.registerOnce({ app: 'ignored', surface: 'docs' });
  loggify.identify('user_1', { email: 'ada@example.com' });
  loggify.people.setOnce({ email: 'other@example.com', plan: 'starter' });
  loggify.timeEvent('Checkout');
  loggify.track('Checkout', { button: 'buy' });
  await loggify.flush();
  const ingest = posts.at(-1);
  const checkout = ingest.body.events.find((event) => event.event === 'Checkout');
  assert.equal(checkout.properties.app, 'web');
  assert.equal(checkout.properties.surface, 'docs');
  assert.equal(checkout.properties.button, 'buy');
  assert.equal(typeof checkout.properties.$duration, 'number');
  assert.equal(checkout.traits.email, 'ada@example.com');
  assert.equal(checkout.traits.plan, 'starter');
  assert.notEqual(checkout.traits.email, 'other@example.com');
  assert.ok(loggify.getDistinctId());
  assert.ok(loggify.getSessionId());
  loggify.shutdown();
});

test('optOut skips ingest and flush retry restores the buffer', async () => {
  let fail = true;
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: 500 };
    return { ok: true, status: 202 };
  };
  const loggify = await loadSdk(fetchImpl);
  await loggify.flush();
  posts.length = 0;
  loggify.track('Retry Me', { n: 1 });
  await loggify.flush();
  assert.equal(posts.length, 1);
  fail = false;
  await loggify.flush();
  assert.equal(posts.length, 2);
  assert.ok(posts[1].body.events.some((event) => event.event === 'Retry Me'));
  posts.length = 0;
  loggify.optOut();
  loggify.track('Secret', { n: 2 });
  await loggify.flush();
  assert.equal(posts.length, 0);
  assert.equal(loggify.hasOptedOut(), true);
  loggify.shutdown();
});
