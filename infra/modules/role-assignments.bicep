// Centralized RBAC for the Function App's system-assigned managed identity.
// Lives in its own module to break the function-app ↔ service-bus / key-vault
// dependency cycle: function-app consumes the SB namespace + KV uri (so it
// must be deployed AFTER them), but the role assignments need the function
// app's principal id — so they're applied AFTER function-app deploys.

@description('Function App system-assigned MI principal ID (functionApp.identity.principalId).')
param functionAppPrincipalId string

@description('Service Bus namespace name (just the name, not the FQDN).')
param serviceBusNamespaceName string

@description('Key Vault name.')
param keyVaultName string

// Built-in role definition IDs:
//   Azure Service Bus Data Sender → 69a216fc-b8fb-44d8-bc22-1f3c2cd27a39
//   Azure Service Bus Data Receiver → 4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0  (Slice B)
//   Key Vault Secrets User → 4633458b-17de-408a-b874-0445c86b69e6
var sbDataSenderRoleId = '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
var sbDataReceiverRoleId = '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0'
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource serviceBus 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' existing = {
  name: serviceBusNamespaceName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// SB Data Sender — webhook receiver enqueues messages.
resource sbSenderRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: serviceBus
  name: guid(serviceBus.id, functionAppPrincipalId, sbDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sbDataSenderRoleId)
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// SB Data Receiver — same app hosts the queue-triggered handler in Slice B.
// Granted now so Slice B doesn't require a separate infra deploy.
resource sbReceiverRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: serviceBus
  name: guid(serviceBus.id, functionAppPrincipalId, sbDataReceiverRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sbDataReceiverRoleId)
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// KV Secrets User — webhook receiver reads per-shop HMAC secrets; Slice C+
// will also read NS TBA creds.
resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, functionAppPrincipalId, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: functionAppPrincipalId
    principalType: 'ServicePrincipal'
  }
}
