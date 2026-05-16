using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
// SQL provisioning is currently restricted in both eastus2 AND eastus for this
// subscription (ProvisioningDisabled on Microsoft.Sql/servers create). Slice A
// (webhook receiver) does not need SQL, so deploySql=false unblocks the deploy.
// Slice B will need SQL — by then, either open a Microsoft support ticket to
// raise the SQL quota for the chosen region, or switch the data layer to
// Postgres Flexible Server (fewer regional quota restrictions on PAYG subs).
param deploySql = false
param sqlLocation = 'eastus'
param resourceGroupName = 'rg-dpi-dev'
param namePrefix = 'dpi'
param sqlAdminLogin = 'dpi-admin'

// IMPORTANT: never commit a real password. Override at deploy time via:
//   --parameters sqlAdminPassword=$(az keyvault secret show ... -o tsv)
// or by passing --parameters in CI secrets. The placeholder below makes
// `bicep build` succeed and is meaningless in any real environment.
param sqlAdminPassword = 'change-me-at-deploy-time'
param keyVaultAdminPrincipalId = ''
