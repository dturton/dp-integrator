import { describe, expect, it } from 'vitest';
import {
  evaluate,
  getPath,
  InMemoryLookupResolver,
  MapDeriveRegistry,
  setPath,
  type EvaluatorContext,
  type Mapping,
} from '../src/index.js';

function ctx(opts: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    lookups: opts.lookups ?? new InMemoryLookupResolver(),
    derives: opts.derives ?? new MapDeriveRegistry(),
  };
}

describe('getPath / setPath', () => {
  it('walks dot paths through nested objects', () => {
    expect(getPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
    expect(getPath({ a: { b: null } }, 'a.b.c')).toBeUndefined();
    expect(getPath(undefined, 'a')).toBeUndefined();
    expect(getPath({ a: 'x' }, '')).toEqual({ a: 'x' });
  });

  it('setPath creates missing intermediates', () => {
    const out: Record<string, unknown> = {};
    setPath(out, 'a.b.c', 42);
    expect(out).toEqual({ a: { b: { c: 42 } } });
  });

  it('setPath overwrites a non-object intermediate with a fresh object', () => {
    const out: Record<string, unknown> = { a: 'leaf' };
    setPath(out, 'a.b', 1);
    expect(out).toEqual({ a: { b: 1 } });
  });

  it('setPath throws on empty path', () => {
    expect(() => setPath({}, '', 1)).toThrow(/non-empty/);
  });
});

describe('evaluate — DirectMap', () => {
  it('copies a top-level field', async () => {
    const mappings: Mapping[] = [{ kind: 'direct', from: 'name', to: 'tranid' }];
    const r = await evaluate({ name: 'SO-1001' }, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ tranid: 'SO-1001' });
  });

  it('copies a nested field via dot path', async () => {
    const mappings: Mapping[] = [{ kind: 'direct', from: 'customer.email', to: 'entity.email' }];
    const r = await evaluate({ customer: { email: 'a@b' } }, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ entity: { email: 'a@b' } });
  });

  it('assigns undefined when source path is missing', async () => {
    const mappings: Mapping[] = [{ kind: 'direct', from: 'missing.field', to: 'out' }];
    const r = await evaluate({}, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ out: undefined });
  });
});

describe('evaluate — ConstantMap', () => {
  it('writes a literal value', async () => {
    const mappings: Mapping[] = [{ kind: 'constant', value: 'sales_order', to: 'recordtype' }];
    const r = await evaluate({}, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ recordtype: 'sales_order' });
  });

  it('writes null/false/0 literals correctly', async () => {
    const r = await evaluate({}, [
      { kind: 'constant', value: null, to: 'a' },
      { kind: 'constant', value: false, to: 'b' },
      { kind: 'constant', value: 0, to: 'c' },
    ], ctx());
    expect(r.ok && r.payload).toEqual({ a: null, b: false, c: 0 });
  });
});

describe('evaluate — LookupMap', () => {
  it('resolves a hit (array-index dot path works because JS arrays are objects)', async () => {
    const lookups = new InMemoryLookupResolver({
      lookup_payment_method: { shopify_payments: 'ns-account-12' },
    });
    const r = await evaluate(
      { transactions: [{ gateway: 'shopify_payments' }] },
      [{ kind: 'lookup', table: 'lookup_payment_method', fromKey: 'transactions.0.gateway', to: 'payment.account' }],
      ctx({ lookups }),
    );
    expect(r.ok && r.payload).toEqual({ payment: { account: 'ns-account-12' } });
  });

  it('resolves a hit using a top-level key', async () => {
    const lookups = new InMemoryLookupResolver({
      lookup_payment_method: { shopify_payments: 'ns-account-12' },
    });
    const mappings: Mapping[] = [
      { kind: 'lookup', table: 'lookup_payment_method', fromKey: 'paymentGateway', to: 'payment.account' },
    ];
    const r = await evaluate({ paymentGateway: 'shopify_payments' }, mappings, ctx({ lookups }));
    expect(r.ok && r.payload).toEqual({ payment: { account: 'ns-account-12' } });
  });

  it('parks as unmapped_construct on lookup miss (required defaults to true)', async () => {
    const mappings: Mapping[] = [
      { kind: 'lookup', table: 'lookup_payment_method', fromKey: 'paymentGateway', to: 'payment.account' },
    ];
    const r = await evaluate({ paymentGateway: 'paypal' }, mappings, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.parked).toMatchObject({
        reason: 'unmapped_construct',
        construct: 'lookup_payment_method',
        evidence: { paymentGateway: 'paypal' },
      });
    }
  });

  it('parks on missing source key (required defaults to true)', async () => {
    const mappings: Mapping[] = [
      { kind: 'lookup', table: 'lookup_payment_method', fromKey: 'missing', to: 'x' },
    ];
    const r = await evaluate({}, mappings, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.parked.detail).toMatch(/source key 'missing' missing/);
  });

  it('writes null instead of parking when required=false and miss', async () => {
    const mappings: Mapping[] = [
      { kind: 'lookup', table: 't', fromKey: 'paymentGateway', to: 'p', required: false },
    ];
    const r = await evaluate({ paymentGateway: 'paypal' }, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ p: null });
  });
});

describe('evaluate — DeriveMap', () => {
  it('calls the registered derive fn and writes its return value', async () => {
    const derives = new MapDeriveRegistry({
      uppercase: ({ field }, source) => {
        const v = (source as Record<string, unknown>)[field as string];
        return typeof v === 'string' ? v.toUpperCase() : v;
      },
    });
    const r = await evaluate(
      { memo: 'hello' },
      [{ kind: 'derive', fn: 'uppercase', args: { field: 'memo' }, to: 'memo' }],
      ctx({ derives }),
    );
    expect(r.ok && r.payload).toEqual({ memo: 'HELLO' });
  });

  it('awaits async derive fns', async () => {
    const derives = new MapDeriveRegistry({
      slow: async () => 'done',
    });
    const r = await evaluate({}, [{ kind: 'derive', fn: 'slow', to: 'result' }], ctx({ derives }));
    expect(r.ok && r.payload).toEqual({ result: 'done' });
  });

  it('throws when the derive fn is not registered', async () => {
    await expect(
      evaluate({}, [{ kind: 'derive', fn: 'missing', to: 'x' }], ctx()),
    ).rejects.toThrow(/derive fn 'missing' is not registered/);
  });
});

describe('evaluate — ConditionalMap', () => {
  it('applies `then` branch when the predicate matches', async () => {
    const mappings: Mapping[] = [
      {
        kind: 'conditional',
        when: { path: 'orderTarget', equals: 'sales_order' },
        then: { kind: 'constant', value: 'salesorder', to: 'recordtype' },
      },
    ];
    const r = await evaluate({ orderTarget: 'sales_order' }, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ recordtype: 'salesorder' });
  });

  it('applies `else` when predicate misses', async () => {
    const mappings: Mapping[] = [
      {
        kind: 'conditional',
        when: { path: 'orderTarget', equals: 'sales_order' },
        then: { kind: 'constant', value: 'salesorder', to: 'recordtype' },
        else: { kind: 'constant', value: 'cashsale', to: 'recordtype' },
      },
    ];
    const r = await evaluate({ orderTarget: 'cash_sale' }, mappings, ctx());
    expect(r.ok && r.payload).toEqual({ recordtype: 'cashsale' });
  });

  it('no-ops when predicate misses and there is no `else`', async () => {
    const r = await evaluate(
      { orderTarget: 'cash_sale' },
      [{ kind: 'conditional', when: { path: 'orderTarget', equals: 'sales_order' }, then: { kind: 'constant', value: 'x', to: 'recordtype' } }],
      ctx(),
    );
    expect(r.ok && r.payload).toEqual({});
  });

  it('propagates a park from a nested branch', async () => {
    const mappings: Mapping[] = [
      {
        kind: 'conditional',
        when: { path: 'orderTarget', equals: 'sales_order' },
        then: { kind: 'lookup', table: 'lookup_payment_method', fromKey: 'paymentGateway', to: 'p' },
      },
    ];
    const r = await evaluate({ orderTarget: 'sales_order', paymentGateway: 'unknown' }, mappings, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.parked.reason).toBe('unmapped_construct');
  });
});

describe('evaluate — composition', () => {
  it('runs a small order-shaped mapping end-to-end', async () => {
    const lookups = new InMemoryLookupResolver({
      lookup_payment_method: { shopify_payments: 'NS-ACCT-12' },
      lookup_currency: { USD: '1' },
    });
    const derives = new MapDeriveRegistry({
      orderName: (_args, source) => {
        const order = source as { name?: string };
        return order.name ? order.name.replace(/^#/, '') : 'unknown';
      },
    });
    const r = await evaluate(
      { name: '#1001', paymentGateway: 'shopify_payments', currency: 'USD', orderTarget: 'sales_order' },
      [
        { kind: 'derive', fn: 'orderName', to: 'tranid' },
        { kind: 'lookup', table: 'lookup_currency', fromKey: 'currency', to: 'currency' },
        { kind: 'lookup', table: 'lookup_payment_method', fromKey: 'paymentGateway', to: 'paymentmethod' },
        {
          kind: 'conditional',
          when: { path: 'orderTarget', equals: 'sales_order' },
          then: { kind: 'constant', value: 'salesorder', to: 'recordtype' },
          else: { kind: 'constant', value: 'cashsale', to: 'recordtype' },
        },
      ],
      { lookups, derives },
    );
    expect(r.ok && r.payload).toEqual({
      tranid: '1001',
      currency: '1',
      paymentmethod: 'NS-ACCT-12',
      recordtype: 'salesorder',
    });
  });

  it('stops at the first park (later mappings are not applied)', async () => {
    const calls: string[] = [];
    const derives = new MapDeriveRegistry({
      tag: (args) => {
        calls.push(args['n'] as string);
        return args['n'];
      },
    });
    const mappings: Mapping[] = [
      { kind: 'derive', fn: 'tag', args: { n: 'first' }, to: 'a' },
      { kind: 'lookup', table: 't', fromKey: 'x', to: 'b' }, // parks
      { kind: 'derive', fn: 'tag', args: { n: 'after-park' }, to: 'c' },
    ];
    const r = await evaluate({ x: 'no-match' }, mappings, ctx({ derives }));
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['first']); // 'after-park' was skipped
  });
});
