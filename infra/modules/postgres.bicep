@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object
@description('Postgres admin login (used to bootstrap; production reads via Entra MI).')
param postgresAdminLogin string
@secure()
param postgresAdminPassword string

// Postgres Flex Server replaces Azure SQL because Azure SQL is gated by an
// opaque per-subscription "ProvisioningDisabled" rule in every region we tried
// (eastus, eastus2). Postgres Flex does not go through the same gate. The data
// shape we store (entity_xref, error_records, lookup_*, ns_governor_slots) is
// dialect-agnostic; the M0 contracts in @dpi/core don't bind to either driver.
//
// Salted uniqueString lets us redeploy past any stale name reservation, same
// trick as sql.bicep used to use.
var serverName = toLower('${namePrefix}-pg-${environmentName}-${uniqueString(resourceGroup().id, 'pg-v1')}')
var databaseName = '${namePrefix}_${environmentName}'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    // Burstable B1ms — 1 vCore, 2 GB. Cheap dev default. Bump to GP_Standard_D2s_v3 for prod.
    name: environmentName == 'prod' ? 'Standard_D2s_v3' : 'Standard_B1ms'
    tier: environmentName == 'prod' ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: environmentName == 'prod' ? 14 : 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      // Both auth modes on. Bootstrap with the password admin; Slice B switches
      // the Function App MI to Entra auth (added as a Postgres principal in a
      // post-deploy step — Bicep can't grant Postgres-internal roles).
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: subscription().tenantId
    }
  }
}

// Open to all Azure services. Tighten in prod to specific outbound IPs / VNet.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pgServer
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pgServer
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverName string = pgServer.name
output serverFqdn string = pgServer.properties.fullyQualifiedDomainName
output databaseName string = db.name
output adminLogin string = postgresAdminLogin
