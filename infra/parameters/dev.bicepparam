using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
// Postgres Flex normally lands in the same region as the rest of the stack;
// kept as a separate param only as an escape hatch for capacity issues.
param postgresLocation = 'eastus2'
param resourceGroupName = 'rg-dpi-dev'
param namePrefix = 'dpi'
param postgresAdminLogin = 'dpiadmin'

// IMPORTANT: never commit a real password. Override at deploy time via:
//   --parameters postgresAdminPassword=$POSTGRES_ADMIN_PASSWORD
// The placeholder below makes `bicep build` succeed and is meaningless in any
// real environment.
param postgresAdminPassword = 'change-me-at-deploy-time'
param keyVaultAdminPrincipalId = ''
// deployPostgres defaults to true in main.bicep; leave it implicit so a dev
// deploy provisions the DB.
