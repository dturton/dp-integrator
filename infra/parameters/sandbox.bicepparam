using '../main.bicep'

param environmentName = 'sandbox'
param location = 'eastus2'
param resourceGroupName = 'rg-dpi-sandbox'
param namePrefix = 'dpi'
param sqlAdminLogin = 'dpi-admin'
param sqlAdminPassword = 'change-me-at-deploy-time'
param keyVaultAdminPrincipalId = ''
