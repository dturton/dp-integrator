// Re-export the SDK's `RecordType` so callers don't need a direct dep on netsuite-sdk.
export type { RecordType } from 'netsuite-sdk';

export { mapNetSuiteError } from './error-mapping.js';
export { governorMiddleware } from './governor-middleware.js';
export {
  NetSuiteClientFactory,
  type NsAccountConfig,
  type NsCredentialRefs,
} from './client-factory.js';
export type { NetSuiteGateway, UpsertResult } from './gateway.js';
export { SdkNetSuiteGateway } from './sdk-gateway.js';
export { FakeNetSuiteGateway } from './fake-gateway.js';
export {
  applyTaxPayloadHeader,
  LegacyTaxStrategy,
  SuiteTaxStrategy,
  strategyFor,
  type TaxPayloadPart,
  type TaxStrategy,
} from './tax-strategy.js';
export {
  buildOrderPayload,
  netsuiteOrderRecordType,
  type BuildOrderPayloadArgs,
  type NsOrderPayload,
} from './payload-builder.js';
export {
  buildDefaultLineItemsMap,
  buildDefaultOrderHeaderMap,
  buildDefaultShippingMap,
} from './default-order-map.js';
export {
  defaultDeriveRegistry,
  parseShopifyDate,
  shopifyLineToItemLine,
  shopifyShippingToLine,
} from './derive-fns.js';
