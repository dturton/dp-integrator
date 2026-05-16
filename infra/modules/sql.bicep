@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object
param sqlAdminLogin string
@secure()
param sqlAdminPassword string

var serverName = toLower('${namePrefix}-sql-${environmentName}-${uniqueString(resourceGroup().id)}')
var databaseName = '${namePrefix}-db-${environmentName}'

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: serverName
  location: location
  tags: tags
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    version: '12.0'
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: '1.2'
    restrictOutboundNetworkAccess: 'Disabled'
  }
}

// Allow Azure services to reach the server (Function App outbound).
resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllAzureIPs'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource db 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: databaseName
  location: location
  tags: tags
  sku: {
    // GP_S_Gen5_1 = General Purpose, Serverless, 1 vCore. Cheap dev default.
    name: environmentName == 'prod' ? 'GP_Gen5_2' : 'GP_S_Gen5_1'
    tier: 'GeneralPurpose'
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    autoPauseDelay: environmentName == 'prod' ? -1 : 60
    minCapacity: json('0.5')
    zoneRedundant: false
  }
}

output serverName string = sqlServer.name
output serverFqdn string = sqlServer.properties.fullyQualifiedDomainName
output databaseName string = db.name
