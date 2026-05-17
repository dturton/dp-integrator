import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import type { QueueProducer } from '@dpi/core';

/**
 * Service Bus producer for the CLI. Mirrors `apps/functions/src/adapters/
 * service-bus-queue-producer.ts` but lives here so the admin app doesn't
 * have to depend on the functions app's adapter package. Both use
 * `DefaultAzureCredential` — in CI / production we run under a managed
 * identity that has `Azure Service Bus Data Sender` on the namespace; the
 * dev's `dpi` CLI relies on their own Entra principal having the same role
 * (granted via `az role assignment create ... --role "Azure Service Bus
 * Data Sender"`).
 *
 * TODO(M2 follow-up): extract this + the functions-side copy into
 * @dpi/azure-adapters so one impl serves both.
 */
export class ServiceBusQueueProducer<T> implements QueueProducer<T> {
  private readonly client: ServiceBusClient;
  private readonly sender: ServiceBusSender;

  constructor(args: {
    fullyQualifiedNamespace: string;
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

  async close(): Promise<void> {
    await this.sender.close();
    await this.client.close();
  }
}
