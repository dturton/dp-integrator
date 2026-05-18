@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object
param appInsightsConnectionString string
param keyVaultUri string
param serviceBusNamespace string
@description('Optional — empty string when Postgres is not deployed yet.')
param postgresHost string = ''
@description('Optional — empty string when Postgres is not deployed yet.')
param postgresDatabase string = ''
@description('Optional — empty string when Postgres is not deployed yet.')
param postgresAdminLogin string = ''

@description('JSON array of connections (string) to bootstrap the receiver. Default empty array; operator seeds via az CLI or pipeline.')
param connectionsJson string = '[]'

@description('Name of the blob container used to persist raw inbound webhook envelopes.')
param inboundContainerName string = 'inbound-webhooks'

var planName = '${namePrefix}-plan-${environmentName}'
var functionAppName = '${namePrefix}-func-${environmentName}-${uniqueString(resourceGroup().id)}'
var storageName = toLower('${namePrefix}st${environmentName}${uniqueString(resourceGroup().id)}')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: substring(storageName, 0, min(24, length(storageName)))
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// Blob service + container for raw inbound webhook envelopes. Brief invariant 3:
// the receiver MUST persist the raw envelope before returning 200 — losing an
// HMAC-verified delivery is unacceptable. The Service Bus message carries only
// the resulting blob URI so the handler (and admin replay) can recover bytes.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {}
}

resource inboundContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: inboundContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Deployment package container (referenced by Flex Consumption `deployment.storage`).
resource appPackageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'app-package'
  properties: {
    publicAccess: 'None'
  }
}

// Outbound NS payload + response archive. M2-D writes one blob per attempt
// (the JSON shipped to NS) and the payload-viewer slice adds a parallel
// `-response.json` blob (what NS returned). Different lifecycle from the
// inbound webhook container — these are debug-grade derived artifacts, not
// HMAC evidence, so retention is shorter. Same MI role assignment covers
// both containers.
resource outboundContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'outbound-netsuite'
  properties: {
    publicAccess: 'None'
  }
}

// Flex Consumption plan — supports always-ready instances so the webhook
// receiver doesn't lose Shopify deliveries to cold starts.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}app-package'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        // Always-ready instance on the receiver path so HMAC-verified
        // Shopify webhooks never miss a cold start.
        alwaysReady: [
          {
            name: 'http'
            instanceCount: environmentName == 'prod' ? 1 : 1
          }
        ]
        maximumInstanceCount: environmentName == 'prod' ? 100 : 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '20'
      }
    }
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storage.name
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'DPI_ENVIRONMENT'
          value: environmentName
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVaultUri
        }
        {
          name: 'SERVICE_BUS_NAMESPACE'
          value: '${serviceBusNamespace}.servicebus.windows.net'
        }
        {
          name: 'SERVICE_BUS_TOPIC'
          value: 'orders-in'
        }
        // Identity-based binding for the v4 Service Bus trigger.
        // `connection: 'SERVICE_BUS'` in the trigger resolves to this app
        // setting; MI on the Function App is granted SB Data Receiver in
        // role-assignments.bicep.
        {
          name: 'SERVICE_BUS__fullyQualifiedNamespace'
          value: '${serviceBusNamespace}.servicebus.windows.net'
        }
        {
          name: 'BLOB_ACCOUNT_URL'
          value: storage.properties.primaryEndpoints.blob
        }
        {
          name: 'INBOUND_BLOB_CONTAINER'
          value: inboundContainerName
        }
        {
          name: 'DPI_CONNECTIONS_JSON'
          value: connectionsJson
        }
        {
          name: 'POSTGRES_HOST'
          value: postgresHost
        }
        {
          name: 'POSTGRES_DATABASE'
          value: postgresDatabase
        }
        {
          name: 'POSTGRES_ADMIN_LOGIN'
          value: postgresAdminLogin
        }
      ]
    }
    httpsOnly: true
  }
}

// --- Role assignments scoped to the storage account ---
// Built-in: Storage Blob Data Contributor (read/write blobs). Required for
// BlobEnvelopeStore.put() and for the Flex Consumption deployment package.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource functionAppStorageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppName string = functionApp.name
output principalId string = functionApp.identity.principalId
output defaultHostName string = functionApp.properties.defaultHostName
output storageAccountId string = storage.id
output storageAccountName string = storage.name
output storageBlobEndpoint string = storage.properties.primaryEndpoints.blob
output inboundContainerName string = inboundContainerName
