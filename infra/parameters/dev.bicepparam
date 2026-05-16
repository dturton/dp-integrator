using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
param resourceGroupName = 'rg-dpi-dev'
param namePrefix = 'dpi'
param sqlAdminLogin = 'dpi-admin'

// IMPORTANT: never commit a real password. Override at deploy time via:
//   --parameters sqlAdminPassword=$(az keyvault secret show ... -o tsv)
// or by passing --parameters in CI secrets. The placeholder below makes
// `bicep build` succeed and is meaningless in any real environment.
param sqlAdminPassword = 'change-me-at-deploy-time'
param keyVaultAdminPrincipalId = ''
