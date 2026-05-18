// Azure Static Web App — hosts the dpi-integrator admin UI (apps/admin-ui).
//
// What the SWA gives us:
//   1. Static hosting for the Vite build output (dist/) — global CDN, free tier.
//   2. Linked-backend → forwards /api/* requests to the function app the SWA
//      is configured against. The link is set post-deploy via:
//        az staticwebapp backends link --backend-resource-id <funcappId>
//      We can't set it via Bicep yet (the API only accepts linked-backend
//      config via the management plane, not ARM templates — Microsoft tracks
//      this on UserVoice). README has the one-liner.
//   3. Easy Auth — by default the SWA accepts anonymous; the staticwebapp.
//      config.json bundled into the dist/ enforces `authenticated` on every
//      route. With Entra as the configured provider (set up post-deploy),
//      unauthenticated requests are redirected to /.auth/login/aad.
//
// Free SKU caps:
//   - 100 GB bandwidth/month, 0.5 GB storage, 2 custom domains, 5 environments
//   - No SLA. For prod, bump to Standard.

@description('Short resource-name prefix (e.g. "dpi"). Combined with env to produce the SWA name.')
@maxLength(8)
param namePrefix string

@description('Environment short name (dev | sandbox | prod).')
@allowed([
  'dev'
  'sandbox'
  'prod'
])
param environmentName string

@description('Azure region for the Static Web App. SWA is global; this is just where the resource record lives.')
param location string = 'eastus2'

@description('Common tags for resource governance.')
param tags object = {}

@description('SKU tier. Standard is required for linked backends (which is how /api/ops/* reaches the Function App without exposing the function key to the browser). Free hosts only "managed functions" embedded in the SWA itself, which we deliberately don''t use here.')
@allowed([
  'Free'
  'Standard'
])
param sku string = 'Standard'

var swaName = '${namePrefix}-swa-${environmentName}'

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: swaName
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    // We don't use the SWA Git integration; deploys come from the GH Actions
    // step that pushes the prebuilt dist/ via the deploy-action token.
    // Leaving repo/branch/buildProperties unset is fine — the resource
    // accepts a "headless" config.
    allowConfigFileUpdates: true
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

@description('SWA default hostname (e.g. ambitious-bay-0123.azurestaticapps.net).')
output defaultHostname string = swa.properties.defaultHostname

@description('Resource id — needed for the post-deploy `az staticwebapp backends link` step.')
output staticWebAppId string = swa.id

@description('SWA resource name (handy for az CLI invocations).')
output staticWebAppName string = swa.name
