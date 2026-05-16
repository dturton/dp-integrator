@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object
@description('Principal granted Key Vault Secrets Officer (deploying user/SP). Optional.')
param adminPrincipalId string = ''

// KV names must be globally unique, 3-24 chars, alphanumeric + hyphens.
var vaultName = toLower('${namePrefix}kv${environmentName}${uniqueString(resourceGroup().id)}')

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: environmentName == 'prod' ? true : null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Built-in role: Key Vault Secrets Officer
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource adminRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminPrincipalId)) {
  scope: kv
  name: guid(kv.id, adminPrincipalId, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: adminPrincipalId
    principalType: 'User'
  }
}

output vaultName string = kv.name
output vaultUri string = kv.properties.vaultUri
output vaultResourceId string = kv.id
