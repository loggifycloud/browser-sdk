# @loggify/browser

First-party browser SDK for Mixpanel-like product analytics and Sentry-style RUM.

```ts
import { loggify } from '@loggify/browser';

loggify.init({
  apiKey: import.meta.env.VITE_LOGGIFY_KEY,
  endpoint: 'http://localhost:3001',
  service: 'web-app',
  environment: 'production',
  release: '1.4.2',
  autocapture: true,
});

loggify.track('Signed Up', { plan: 'pro' });
loggify.identify('user_123', { email: 'ada@example.com' });
loggify.people.set({ plan: 'pro' });
loggify.setUser({ id: 'user_123', email: 'ada@example.com' });
loggify.addBreadcrumb({ category: 'ui', message: 'opened checkout' });
loggify.reset(); // logout
```

Automatic:

- `$pageview` / `$pageleave`, SPA `pushState` / `popstate`
- UTM, referrer, device / OS / browser, session id
- Optional click / submit autocapture (passwords redacted, values truncated)
- `error` and `unhandledrejection` → existing errors pipeline
- `fetch` / XHR client spans with `traceparent`
- Web Vitals LCP, INP, CLS, TTFB, FCP as metrics
