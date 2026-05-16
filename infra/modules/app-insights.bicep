@description('Short resource-name prefix.')
param namePrefix string
@description('Environment short name (dev|sandbox|prod).')
param environmentName string
param location string
param tags object

var workspaceName = '${namePrefix}-law-${environmentName}'
var appInsightsName = '${namePrefix}-ai-${environmentName}'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource ai 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}

output workspaceId string = workspace.id
output connectionString string = ai.properties.ConnectionString
output instrumentationKey string = ai.properties.InstrumentationKey
