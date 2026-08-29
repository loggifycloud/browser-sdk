export interface BrowserOptions {
  apiKey: string;
  endpoint?: string;
  service?: string;
  environment?: string;
  release?: string;
  autocapture?: boolean;
  sampleRate?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
}

type Properties = Record<string, unknown>;

interface AnalyticsRow {
  event: string;
  properties?: Properties;
  distinctId: string;
  userId?: string;
  sessionId: string;
  timestamp: string;
  kind?: string;
  traits?: Properties;
  pageUrl?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  device?: string;
  os?: string;
  browser?: string;
  release?: string;
  serviceName?: string;
  environment?: string;
}

interface ErrorRow {
  message: string;
  exceptionType: string;
  stackTrace?: string;
  endpoint?: string;
  release?: string;
  userId?: string;
  user?: Record<string, string>;
  breadcrumbs?: Array<{ timestamp: string; category: string; message: string; level?: string }>;
}

interface MetricRow {
  metricName: string;
  value: number;
  tags?: Record<string, string>;
}

interface SpanRow {
  spanId: string;
  name: string;
  kind: string;
  status: string;
  timestamp: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
}

const AID = 'loggify_aid';
const SID = 'loggify_sid';
const SID_AT = 'loggify_sid_at';
const SESSION_MS = 30 * 60_000;
const SENSITIVE = /password|token|secret|authorization|cookie|ssn|card/i;

class BufferQueue<T> {
  items: T[] = [];
  constructor(private readonly max: number) {}
  push(item: T) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(item);
  }
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

function hex(bytes: number) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ua() {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const uaString = nav?.userAgent ?? '';
  const mobile = /Mobi|Android/i.test(uaString);
  return {
    device: mobile ? 'mobile' : 'desktop',
    os: /Mac/i.test(uaString) ? 'macOS' : /Win/i.test(uaString) ? 'Windows' : /Linux/i.test(uaString) ? 'Linux' : 'unknown',
    browser: /Edg/i.test(uaString)
      ? 'Edge'
      : /Chrome/i.test(uaString)
        ? 'Chrome'
        : /Safari/i.test(uaString)
          ? 'Safari'
          : /Firefox/i.test(uaString)
            ? 'Firefox'
            : 'unknown',
  };
}

function utmFrom(url: string) {
  try {
    const parsed = new URL(url);
    return {
      utmSource: parsed.searchParams.get('utm_source') ?? '',
      utmMedium: parsed.searchParams.get('utm_medium') ?? '',
      utmCampaign: parsed.searchParams.get('utm_campaign') ?? '',
    };
  } catch {
    return { utmSource: '', utmMedium: '', utmCampaign: '' };
  }
}

function safeValue(value: unknown) {
  if (value == null) return '';
  return String(value).slice(0, 120);
}

class LoggifyBrowser {
  private opts!: BrowserOptions;
  private events = new BufferQueue<AnalyticsRow>(200);
  private errors = new BufferQueue<ErrorRow>(100);
  private metrics = new BufferQueue<MetricRow>(100);
  private spans = new BufferQueue<SpanRow>(100);
  private breadcrumbs: Array<{ timestamp: string; category: string; message: string; level?: string }> = [];
  private user: Record<string, string> = {};
  private distinctId = '';
  private sessionId = '';
  private pageEntered = 0;
  private timer?: ReturnType<typeof setInterval>;
  private instrumented = false;
  readonly people: { set: (traits: Properties) => LoggifyBrowser } = {
    set: (traits: Properties) => this.identify(this.user.id || this.distinctId, traits),
  };

  init(options: BrowserOptions) {
    this.opts = {
      endpoint: 'https://ingest.loggify.cloud',
      service: 'browser',
      environment: 'production',
      autocapture: true,
      sampleRate: 1,
      flushIntervalMs: 4000,
      maxBuffer: 200,
      ...options,
    };
    this.events = new BufferQueue(this.opts.maxBuffer ?? 200);
    this.hydrateIds();
    if (this.instrumented) return this;
    this.instrumented = true;
    this.pageEntered = Date.now();
    this.track('$pageview', this.pageProps());
    this.hookPageLeave();
    this.hookSpa();
    this.hookErrors();
    this.hookFetch();
    this.hookVitals();
    if (this.opts.autocapture !== false) this.hookAutocapture();
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush();
      });
    }
    return this;
  }

  track(event: string, properties: Properties = {}) {
    if (!this.opts) return this;
    const info = ua();
    const utm = utmFrom(typeof location === 'undefined' ? '' : location.href);
    this.events.push({
      event,
      properties: this.sanitize(properties),
      distinctId: this.distinctId,
      userId: this.user.id,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      kind: event === '$pageview' ? 'page' : 'track',
      pageUrl: typeof location === 'undefined' ? '' : location.href,
      referrer: typeof document === 'undefined' ? '' : document.referrer,
      ...utm,
      ...info,
      release: this.opts.release,
      serviceName: this.opts.service,
      environment: this.opts.environment,
    });
    this.crumb('navigation', event);
    return this;
  }

  identify(userId: string, traits: Properties = {}) {
    this.user = { ...this.user, id: userId, ...this.stringRecord(traits) };
    this.events.push({
      event: '$identify',
      kind: 'identify',
      distinctId: this.distinctId,
      userId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traits: this.sanitize(traits),
      properties: this.sanitize(traits),
      release: this.opts?.release,
      serviceName: this.opts?.service,
      environment: this.opts?.environment,
    });
    return this;
  }

  reset() {
    this.user = {};
    this.distinctId = hex(16);
    this.sessionId = hex(8);
    try {
      localStorage.setItem(AID, this.distinctId);
      sessionStorage.setItem(SID, this.sessionId);
      sessionStorage.setItem(SID_AT, String(Date.now()));
    } catch {
      /* ignore */
    }
    return this;
  }

  setUser(user: Record<string, string> | null) {
    this.user = user ? { ...user } : {};
    if (user?.id) this.identify(user.id, user);
    return this;
  }

  addBreadcrumb(crumb: { category?: string; message: string; level?: string }) {
    this.crumb(crumb.category ?? 'manual', crumb.message, crumb.level);
    return this;
  }

  setRelease(release: string) {
    if (this.opts) this.opts.release = release;
    return this;
  }

  captureException(err: unknown, extra?: Partial<ErrorRow>) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({
      message: error.message,
      exceptionType: error.name,
      stackTrace: error.stack,
      endpoint: typeof location === 'undefined' ? '' : location.pathname,
      release: this.opts?.release,
      userId: this.user.id,
      user: this.user,
      breadcrumbs: this.breadcrumbs.slice(-50),
      ...extra,
    });
    this.crumb('error', error.message, 'error');
    return this;
  }

  async flush() {
    const events = this.events.drain();
    const errors = this.errors.drain();
    const metrics = this.metrics.drain();
    const spanEvents = this.spans.drain();
    if (!events.length && !errors.length && !metrics.length && !spanEvents.length) return;
    const traces = spanEvents.length
      ? [
          {
            traceId: hex(16),
            serviceName: this.opts.service,
            environment: this.opts.environment,
            spans: spanEvents,
          },
        ]
      : [];
    await this.post({ events, errors, metrics, traces });
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.instrumented = false;
    return this;
  }

  private hydrateIds() {
    try {
      this.distinctId = localStorage.getItem(AID) || hex(16);
      localStorage.setItem(AID, this.distinctId);
      const last = Number(sessionStorage.getItem(SID_AT) || 0);
      const existing = sessionStorage.getItem(SID);
      if (existing && Date.now() - last < SESSION_MS) {
        this.sessionId = existing;
      } else {
        this.sessionId = hex(8);
        sessionStorage.setItem(SID, this.sessionId);
      }
      sessionStorage.setItem(SID_AT, String(Date.now()));
    } catch {
      this.distinctId = this.distinctId || hex(16);
      this.sessionId = this.sessionId || hex(8);
    }
  }

  private pageProps() {
    return {
      $current_url: typeof location === 'undefined' ? '' : location.href,
      path: typeof location === 'undefined' ? '' : location.pathname,
      title: typeof document === 'undefined' ? '' : document.title,
      $referrer: typeof document === 'undefined' ? '' : document.referrer,
    };
  }

  private hookPageLeave() {
    const leave = () => {
      this.track('$pageleave', { ...this.pageProps(), duration_ms: Date.now() - this.pageEntered });
      void this.flush();
    };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', leave);
  }

  private hookSpa() {
    if (typeof history === 'undefined') return;
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    const onChange = () => {
      this.pageEntered = Date.now();
      this.track('$pageview', this.pageProps());
    };
    history.pushState = (...args) => {
      origPush(...args);
      onChange();
    };
    history.replaceState = (...args) => {
      origReplace(...args);
      onChange();
    };
    window.addEventListener('popstate', onChange);
  }

  private hookErrors() {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (event) => {
      this.captureException(event.error ?? new Error(event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      this.captureException(event.reason);
    });
  }

  private hookFetch() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    const orig = window.fetch.bind(window);
    const self = this;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes(self.opts.endpoint ?? '')) return orig(input, init);
      const started = performance.now();
      const spanId = hex(8);
      const traceId = hex(16);
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
      headers.set('traceparent', `00-${traceId}-${spanId}-01`);
      try {
        const res = await orig(input, { ...init, headers });
        self.spans.push({
          spanId,
          name: `HTTP ${init?.method ?? 'GET'}`,
          kind: 'client',
          status: res.ok ? 'ok' : 'error',
          timestamp: new Date(Date.now() - (performance.now() - started)).toISOString(),
          durationMs: performance.now() - started,
          attributes: { 'http.url': url, 'http.status_code': res.status, 'http.method': init?.method ?? 'GET' },
        });
        return res;
      } catch (error) {
        self.spans.push({
          spanId,
          name: `HTTP ${init?.method ?? 'GET'}`,
          kind: 'client',
          status: 'error',
          timestamp: new Date().toISOString(),
          durationMs: performance.now() - started,
          attributes: { 'http.url': url },
        });
        throw error;
      }
    };
    const xhr = XMLHttpRequest.prototype;
    const open = xhr.open;
    const send = xhr.send;
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      (this as XMLHttpRequest & { __loggify?: { method: string; url: string; start: number } }).__loggify = {
        method,
        url: String(url),
        start: 0,
      };
      return open.apply(this, [method, url, ...rest] as never);
    };
    xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = (this as XMLHttpRequest & { __loggify?: { method: string; url: string; start: number } }).__loggify;
      if (meta) meta.start = performance.now();
      this.addEventListener('loadend', () => {
        if (!meta || meta.url.includes(self.opts.endpoint ?? '')) return;
        self.spans.push({
          spanId: hex(8),
          name: `HTTP ${meta.method}`,
          kind: 'client',
          status: this.status >= 500 ? 'error' : 'ok',
          timestamp: new Date().toISOString(),
          durationMs: performance.now() - meta.start,
          attributes: { 'http.url': meta.url, 'http.status_code': this.status, 'http.method': meta.method },
        });
      });
      return send.call(this, body);
    };
  }

  private hookVitals() {
    if (typeof PerformanceObserver === 'undefined') return;
    const push = (name: string, value: number) => {
      this.metrics.push({
        metricName: `web_vital.${name}`,
        value,
        tags: { path: typeof location === 'undefined' ? '' : location.pathname },
      });
    };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as (PerformanceEntry & { startTime: number }) | undefined;
        if (last) push('lcp', last.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true } as PerformanceObserverInit);
    } catch {
      /* unsupported */
    }
    try {
      let cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
        push('cls', cls);
      }).observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
    } catch {
      /* unsupported */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { duration: number }>) {
          push('inp', entry.duration);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    } catch {
      /* unsupported */
    }
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      push('ttfb', nav.responseStart);
      push('fcp', nav.domContentLoadedEventEnd);
    }
  }

  private hookAutocapture() {
    if (typeof document === 'undefined') return;
    document.addEventListener(
      'click',
      (event) => {
        const el = (event.target as Element | null)?.closest?.('button, a, [data-loggify]');
        if (!el) return;
        this.track('$autocapture', {
          $event_type: 'click',
          tag: el.tagName,
          text: safeValue(el.textContent),
          href: safeValue(el.getAttribute('href')),
        });
      },
      true,
    );
    document.addEventListener(
      'submit',
      (event) => {
        const form = event.target as HTMLFormElement;
        if (!(form instanceof HTMLFormElement)) return;
        const fields: Record<string, string> = {};
        for (const field of Array.from(form.elements)) {
          const input = field as HTMLInputElement;
          const name = input.name || input.id;
          if (!name || input.type === 'password' || SENSITIVE.test(name)) continue;
          fields[name] = safeValue(input.value);
        }
        this.track('$autocapture', { $event_type: 'submit', fields });
      },
      true,
    );
  }

  private crumb(category: string, message: string, level?: string) {
    this.breadcrumbs.push({ timestamp: new Date().toISOString(), category, message: message.slice(0, 512), level });
    if (this.breadcrumbs.length > 50) this.breadcrumbs.shift();
  }

  private sanitize(value: Properties): Properties {
    const out: Properties = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? '[REDACTED]' : typeof item === 'string' ? item.slice(0, 500) : item;
    }
    return out;
  }

  private stringRecord(value: Properties) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  }

  private async post(body: unknown) {
    if (Math.random() > (this.opts.sampleRate ?? 1)) return;
    try {
      await fetch(`${this.opts.endpoint}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch {
      /* never throw into host app */
    }
  }
}

export const loggify = new LoggifyBrowser();
export default loggify;
export const Monitor = loggify;
