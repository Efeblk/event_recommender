import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json' with { type: 'json' };

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;
const deployTarget = process.env.DEPLOY_TARGET;

function requiredDeploymentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when DEPLOY_TARGET is set.`);
  return value;
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const bindingConfig = deployTarget
  ? {
      name: requiredDeploymentValue('CF_WORKER_NAME'),
      main: 'vinext/server/fetch-handler',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: requiredDeploymentValue('CF_D1_DATABASE_NAME'),
          database_id: requiredDeploymentValue('CF_D1_DATABASE_ID'),
          migrations_dir: 'drizzle',
        },
      ],
      r2_buckets: [
        {
          binding: 'COLLECTION_STATE',
          bucket_name: requiredDeploymentValue('CF_R2_BUCKET_NAME'),
        },
      ],
    }
  : {
      main: 'vinext/server/fetch-handler',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: d1
        ? [
            {
              binding: d1,
              database_name: 'site-creator-d1',
              database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
            },
          ]
        : [],
      r2_buckets: [
        ...(r2 && r2 !== 'COLLECTION_STATE'
          ? [{ binding: r2, bucket_name: 'site-creator-r2' }]
          : []),
        {
          binding: 'COLLECTION_STATE',
          bucket_name: 'biplan-local-collection-state',
        },
      ],
    };

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      ...(deployTarget ? [] : [sites()]),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: bindingConfig,
      }),
    ],
  };
});
