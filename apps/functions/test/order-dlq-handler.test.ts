import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryErrorStore,
  type Connection,
} from '@dpi/core';
import {
  handleDeadLetteredOrder,
  type DlqHandlerDeps,
} from '../src/triggers/order-dlq-handler.js';
import type { InvocationContext } from '@azure/functions';

const acme: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'shopify-client-id-acme-us',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-acme-us',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

function build(opts: { withErrorStore?: boolean } = {}): {
  deps: DlqHandlerDeps;
  errorStore: InMemoryErrorStore;
} {
  const errorStore = new InMemoryErrorStore();
  return {
    errorStore,
    deps: {
      environment: 'dev',
      connections: new InMemoryConnectionsRepo([acme]),
      errorStore: opts.withErrorStore === false ? undefined : errorStore,
    },
  };
}

function ctx(triggerMetadata?: Record<string, unknown>): InvocationContext {
  return { triggerMetadata: triggerMetadata ?? {}, log: () => undefined } as unknown as InvocationContext;
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    environment: 'dev',
    connectionId: 'acme-us',
    shopDomain: 'acme-us.myshopify.com',
    topic: 'orders/create',
    orderGid: 'gid://shopify/Order/12345',
    envelopeBlobUri: 'https://blob.example.test/x.json',
    receivedAt: '2026-05-17T10:00:00Z',
    ...overrides,
  };
}

describe('handleDeadLetteredOrder', () => {
  it('records an error_records row tagged quarantined for a normal DLQ message', async () => {
    const { deps, errorStore } = build();

    const outcome = await handleDeadLetteredOrder(deps, envelope(), ctx({ deliveryCount: 10 }));

    expect(outcome.kind).toBe('recorded');
    if (outcome.kind !== 'recorded') return;
    expect(errorStore.size()).toBe(1);
    const [row] = await errorStore.list();
    expect(row?.status).toBe('quarantined');
    expect(row?.environment).toBe('dev');
    expect(row?.connectionId).toBe('acme-us');
    expect(row?.flow).toBe('order-import');
    expect(row?.errorClass).toBe('unknown');
    expect(row?.dedupKey).toContain('acme-us');
    expect(row?.dedupKey).toContain('Order/12345');
    expect(row?.message).toMatch(/exhausted SB redeliveries/);
  });

  it('uses DeadLetterReason / DeadLetterErrorDescription when present in app properties', async () => {
    const { deps, errorStore } = build();

    await handleDeadLetteredOrder(deps, envelope(), ctx({
      applicationProperties: {
        DeadLetterReason: 'MaxDeliveryCountExceeded',
        DeadLetterErrorDescription: 'cannot upsert salesorder',
      },
      deliveryCount: 10,
    }));

    const [row] = await errorStore.list();
    expect(row?.message).toMatch(/MaxDeliveryCountExceeded/);
    expect(row?.message).toMatch(/cannot upsert salesorder/);
  });

  it('records a forensic row for an unparseable envelope (so nothing vanishes)', async () => {
    const { deps, errorStore } = build();

    const outcome = await handleDeadLetteredOrder(deps, { not: 'a valid envelope' }, ctx());

    expect(outcome.kind).toBe('unrecorded');
    if (outcome.kind === 'unrecorded') expect(outcome.reason).toBe('bad_envelope');
    expect(errorStore.size()).toBe(1);
    const [row] = await errorStore.list();
    expect(row?.connectionId).toBe('unknown');
    expect(row?.dedupKey).toBe('unparseable');
    expect(row?.envelope).toEqual({ not: 'a valid envelope' });
  });

  it('records under unknown_connection when the connectionId is not configured', async () => {
    const { deps, errorStore } = build();

    const outcome = await handleDeadLetteredOrder(
      deps,
      envelope({ connectionId: 'never-heard-of-it' }),
      ctx(),
    );

    expect(outcome.kind).toBe('unrecorded');
    if (outcome.kind === 'unrecorded') expect(outcome.reason).toBe('unknown_connection');
    expect(errorStore.size()).toBe(1);
    const [row] = await errorStore.list();
    expect(row?.connectionId).toBe('never-heard-of-it');
    expect(row?.message).toMatch(/connection 'never-heard-of-it' not found/);
  });

  it('returns no_error_store when bootstrap is missing PG (no DB writes attempted)', async () => {
    const { deps } = build({ withErrorStore: false });

    const outcome = await handleDeadLetteredOrder(deps, envelope(), ctx());

    expect(outcome).toMatchObject({ kind: 'unrecorded', reason: 'no_error_store' });
  });
});
