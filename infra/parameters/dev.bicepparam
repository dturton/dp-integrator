using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
// SQL provisioning is disabled in eastus2 for this subscription
// (ProvisioningDisabled / Conflict on Microsoft.Sql/servers create); use eastus
// for the SQL server only. Other resources stay in eastus2 to preserve the
// already-deployed Key Vault / Service Bus / Log Analytics / App Insights.
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
