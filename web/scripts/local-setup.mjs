import { ensureLocalToken, requireNode22 } from './local-config.mjs';

requireNode22();
await ensureLocalToken();
console.log(
  'Local authentication is ready in ignored web/.dev.vars (token hidden).',
);
