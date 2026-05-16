import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import type { QueueProducer } from '@dpi/core';

/**
 * Production `QueueProducer<T>` backed by Azure Service Bus (topic).
 *
 * Authenticates via `DefaultAzureCredential` — in Azure the Function App's
 * managed identity has `Azure Service Bus Data Sender` on the namespace
 * (granted in Bicep). The infra Bicep provisions a single topic (`orders-in`)
 * with a session-required subscription (`order-import`); this producer sends
 * with `sessionId` so the consumer receives in per-key FIFO order.
 */
export class ServiceBusQueueProducer<T> implements QueueProducer<T> {
  private readonly client: ServiceBusClient;
  private readonly sender: ServiceBusSender;

  constructor(args: {
    /** Fully qualified namespace, e.g. `dpi-sb-dev-xxx.servicebus.windows.net`. */
    fullyQualifiedNamespace: string;
    /** Topic name, e.g. `orders-in`. */
    topic: string;
    credential?: TokenCredential;
  }) {
    const credential = args.credential ?? new DefaultAzureCredential();
    this.client = new ServiceBusClient(args.fullyQualifiedNamespace, credential);
    this.sender = this.client.createSender(args.topic);
  }

  async enqueue(message: { sessionId?: string; body: T }): Promise<void> {
    await this.sender.sendMessages({
      body: message.body,
      sessionId: message.sessionId,
      contentType: 'application/json',
    });
  }

  /** Releases the AMQP link + connection. Call on host shutdown. */
  async close(): Promise<void> {
    await this.sender.close();
    await this.client.close();
  }
}
