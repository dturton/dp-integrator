import { describe, expect, it, vi } from 'vitest';
import { ShopifyTokenService } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CREDS = {
  shopDomain: 'acme.myshopify.com',
  clientId: 'cid_aaa',
  clientSecret: 'shpss_bbb',
};

describe('ShopifyTokenService', () => {
  it('exchanges client credentials for an access token (POST x-www-form-urlencoded)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'shpat_xxx', scope: 'read_orders', expires_in: 86399 }),
    );
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });

    const token = await svc.getAccessToken(CREDS);

    expect(token.accessToken).toBe('shpat_xxx');
    expect(token.scope).toBe('read_orders');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('client_id=cid_aaa');
    expect(body).toContain('client_secret=shpss_bbb');
    expect(body).toContain('grant_type=client_credentials');
  });

  it('caches the token across calls (no second fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'shpat_xxx', expires_in: 3600 }),
    );
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    const a = await svc.getAccessToken(CREDS);
    const b = await svc.getAccessToken(CREDS);
    expect(a.accessToken).toBe(b.accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes when within refreshBufferMs of expiry', async () => {
    let now = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'first', expires_in: 600 })) // 10 min ttl
      .mockResolvedValueOnce(jsonResponse({ access_token: 'second', expires_in: 600 }));
    const svc = new ShopifyTokenService({
      fetchImpl: fetchMock,
      refreshBufferMs: 5 * 60 * 1000, // 5 min buffer
      now: () => now,
    });
    const a = await svc.getAccessToken(CREDS);
    expect(a.accessToken).toBe('first');
    // Advance time past (expiresAt - 5 min) — refresh triggered.
    now += 6 * 60 * 1000; // jump 6 min
    const b = await svc.getAccessToken(CREDS);
    expect(b.accessToken).toBe('second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent token fetches to a single HTTP call', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((r) => { resolve = r; }),
    );
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    const p1 = svc.getAccessToken(CREDS);
    const p2 = svc.getAccessToken(CREDS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(jsonResponse({ access_token: 'shpat_zz', expires_in: 86399 }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.accessToken).toBe('shpat_zz');
    expect(b.accessToken).toBe('shpat_zz');
  });

  it('invalidate() forces a refetch on the next call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'first', expires_in: 86399 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'second', expires_in: 86399 }));
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    expect((await svc.getAccessToken(CREDS)).accessToken).toBe('first');
    svc.invalidate(CREDS.shopDomain);
    expect((await svc.getAccessToken(CREDS)).accessToken).toBe('second');
  });

  it('throws on non-2xx response, including body text in the error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('forbidden: bad client_secret', { status: 401 }));
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    await expect(svc.getAccessToken(CREDS)).rejects.toThrow(/401.*bad client_secret/);
  });

  it('throws when response is 200 but has no access_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ scope: 'read_orders' }));
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    await expect(svc.getAccessToken(CREDS)).rejects.toThrow(/no access_token/);
  });

  it('defaults expires_in to 1h when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'x' }));
    const now = 1_000_000;
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock, now: () => now });
    const t = await svc.getAccessToken(CREDS);
    expect(t.expiresAt).toBe(now + 3600 * 1000);
  });

  it('uses a separate cache slot per shop domain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'A', expires_in: 86399 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'B', expires_in: 86399 }));
    const svc = new ShopifyTokenService({ fetchImpl: fetchMock });
    const a = await svc.getAccessToken({ ...CREDS, shopDomain: 'a.myshopify.com' });
    const b = await svc.getAccessToken({ ...CREDS, shopDomain: 'b.myshopify.com' });
    expect(a.accessToken).toBe('A');
    expect(b.accessToken).toBe('B');
  });
});
