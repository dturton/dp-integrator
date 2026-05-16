@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object

var namespaceName = toLower('${namePrefix}-sb-${environmentName}-${uniqueString(resourceGroup().id)}')
var topicName = 'orders-in'
var subscriptionName = 'order-import'

resource ns 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    disableLocalAuth: false
    publicNetworkAccess: 'Enabled'
  }
}

// One inbound topic per direction; subscription per flow with sessions enabled
// for per-(connection, orderId) FIFO and DLQ for parked records.
resource topic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = {
  parent: ns
  name: topicName
  properties: {
    requiresDuplicateDetection: false
    enablePartitioning: false
    supportOrdering: true
    defaultMessageTimeToLive: 'P14D'
  }
}

resource subscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview' = {
  parent: topic
  name: subscriptionName
  properties: {
    requiresSession: true
    lockDuration: 'PT5M'
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    deadLetteringOnFilterEvaluationExceptions: true
    defaultMessageTimeToLive: 'P14D'
  }
}

output namespaceName string = ns.name
output namespaceId string = ns.id
output topicName string = topic.name
output subscriptionName string = subscription.name
