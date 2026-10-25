import {
  DEFAULT_LIMIT,
  LOGIN_LIMIT,
  MINUTE,
  ONBOARDING_LIMIT,
  REFRESH_LIMIT,
} from './rate-limits';

describe('rate limits', () => {
  const variables = [
    'AUTH_LOGIN_RATE_LIMIT',
    'AUTH_REFRESH_RATE_LIMIT',
    'ONBOARDING_RATE_LIMIT',
    'RATE_LIMIT_DEFAULT',
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    saved.clear();
    for (const variable of variables) {
      saved.set(variable, process.env[variable]);
      delete process.env[variable];
    }
  });

  afterEach(() => {
    for (const variable of variables) {
      const value = saved.get(variable);
      if (value === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = value;
      }
    }
  });

  it('falls back to the documented defaults', () => {
    expect(LOGIN_LIMIT()).toBe(20);
    expect(REFRESH_LIMIT()).toBe(30);
    expect(ONBOARDING_LIMIT()).toBe(10);
    expect(DEFAULT_LIMIT()).toBe(300);
  });

  it('reads the limits from the environment on every call', () => {
    process.env.AUTH_LOGIN_RATE_LIMIT = '5';
    expect(LOGIN_LIMIT()).toBe(5);

    // The e2e suite raises and lowers a limit between requests, so the value
    // must not be captured once at import time.
    process.env.AUTH_LOGIN_RATE_LIMIT = '7';
    expect(LOGIN_LIMIT()).toBe(7);
  });

  it('ignores an empty, malformed or non-positive value', () => {
    for (const value of ['', '   ', 'abc', '0', '-3', 'NaN']) {
      process.env.AUTH_LOGIN_RATE_LIMIT = value;
      expect(LOGIN_LIMIT()).toBe(20);
    }
  });

  it('truncates a fractional limit', () => {
    process.env.AUTH_LOGIN_RATE_LIMIT = '12.9';
    expect(LOGIN_LIMIT()).toBe(12);
  });

  it('measures the window in milliseconds', () => {
    expect(MINUTE).toBe(60_000);
  });
});
