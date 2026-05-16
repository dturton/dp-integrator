// dp-integrator infra root — subscription-scoped.
//
// Composes the five service modules: Function App (Flex Consumption + always-ready
// instances), Service Bus (topic + session-required subscription + DLQ), Azure SQL,
// Key Vault, and App Insights (with Log Analytics workspace backing it).
//
// Usage (see Makefile):
//   make infra-plan   ENV=dev    # dry-run (az deployment sub what-if)
//   make infra-deploy ENV=dev    # apply, prompts for confirmation

targetScope = 'subscription'

@description('Environment short name (dev | sandbox | prod). Used in resource naming and tagging.')
@allowed([
  'dev'
  'sandbox'
  'prod'
])
param environmentName string

@description('Azure region for all resources.')
param location string = 'eastus2'

@description('Resource group to create (or update) for this environment.')
param resourceGroupName string = 'rg-dpi-${environmentName}'

@description('Short resource name suffix — keeps names within Azure limits.')
@maxLength(8)
param namePrefix string = 'dpi'

@description('Azure SQL admin login.')
param sqlAdminLogin string = 'dpi-admin'

@description('Azure SQL admin password.')
@secure()
param sqlAdminPassword string

@description('Object ID (principal) granted Key Vault Secrets Officer at deploy time. Usually the deploying user/service principal.')
param keyVaultAdminPrincipalId string = ''

@description('JSON-stringified array of connection records to seed the receiver with. Defaults to an empty array; operator seeds via az CLI / pipeline secret. NEVER include raw secrets — connections carry KV refs.')
param connectionsJson string = '[]'

var commonTags = {
  workload: 'dp-integrator'
  env: environmentName
  managedBy: 'bicep'
}

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: commonTags
}

module appInsights './modules/app-insights.bicep' = {
  scope: rg
  name: 'app-insights'
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
  }
}

module keyVault './modules/key-vault.bicep' = {
  scope: rg
  name: 'key-vault'
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    adminPrincipalId: keyVaultAdminPrincipalId
  }
}

module sql './modules/sql.bicep' = {
  scope: rg
  name: 'sql'
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    sqlAdminLogin: sqlAdminLogin
    sqlAdminPassword: sqlAdminPassword
  }
}

module serviceBus './modules/service-bus.bicep' = {
  scope: rg
  name: 'service-bus'
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
  }
}

module functionApp './modules/function-app.bicep' = {
  scope: rg
  name: 'function-app'
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    appInsightsConnectionString: appInsights.outputs.connectionString
    keyVaultUri: keyVault.outputs.vaultUri
    serviceBusNamespace: serviceBus.outputs.namespaceName
    sqlServerFqdn: sql.outputs.serverFqdn
    sqlDatabaseName: sql.outputs.databaseName
    connectionsJson: connectionsJson
  }
}

module appRoles './modules/role-assignments.bicep' = {
  scope: rg
  name: 'app-role-assignments'
  params: {
    functionAppPrincipalId: functionApp.outputs.principalId
    serviceBusNamespaceName: serviceBus.outputs.namespaceName
    keyVaultName: keyVault.outputs.vaultName
  }
}

output functionAppName string = functionApp.outputs.functionAppName
output functionAppPrincipalId string = functionApp.outputs.principalId
output keyVaultUri string = keyVault.outputs.vaultUri
output keyVaultName string = keyVault.outputs.vaultName
output serviceBusNamespace string = serviceBus.outputs.namespaceName
output sqlServerFqdn string = sql.outputs.serverFqdn
output sqlDatabaseName string = sql.outputs.databaseName
output appInsightsConnectionString string = appInsights.outputs.connectionString
output storageAccountName string = functionApp.outputs.storageAccountName
output storageBlobEndpoint string = functionApp.outputs.storageBlobEndpoint
output inboundContainerName string = functionApp.outputs.inboundContainerName
output webhookUrl string = 'https://${functionApp.outputs.defaultHostName}/api/webhooks/shopify/orders'
