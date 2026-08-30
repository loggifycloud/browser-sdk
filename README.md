# @loggifycloud/browser

First-party browser SDK for Mixpanel-like product analytics and Sentry-style RUM.

```ts
import { loggify } from '@loggifycloud/browser';

loggify.init({
  apiKey: import.meta.env.VITE_LOGGIFY_KEY,
  endpoint: 'https://ingest.loggify.cloud',
  service: 'web-app',
  environment: 'production',
  release: '1.4.2',
  autocapture: true,
});

loggify.register({ app: 'web' });
loggify.identify('user_123', { email: 'ada@example.com' });
loggify.people.set({ plan: 'pro' });
loggify.people.setOnce({ plan: 'starter' }); // skipped if plan already set
loggify.timeEvent('Checkout');
loggify.track('Checkout', { item: 'pro' }); // includes $duration and super properties
loggify.reset(); // logout — new anonymous distinct id
loggify.optOut(); // stop sending
```

Automatic:

- `$pageview` / `$pageleave`, SPA `pushState` / `popstate`
- Super properties (`register` / `registerOnce` / `unregister`) on every `track`
- People profile snapshot on every event (`people.set` / `setOnce` / `increment`)
- UTM, referrer, device / OS / browser, session id
- Optional click / submit autocapture (passwords redacted, values truncated)
- `error` and `unhandledrejection` → existing errors pipeline
- `fetch` / XHR client spans with `traceparent`
- Web Vitals LCP, INP, CLS, TTFB, FCP as metrics
- Failed ingest posts are retried on the next flush
