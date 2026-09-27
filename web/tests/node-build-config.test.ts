import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await test('Node container context excludes credentials and local artifacts', async () => {
  const ignored = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  for (const required of ['.env*', '.dev.vars*', '.npmrc', '*.pem', 'node_modules', 'work', 'dist', 'dist-node', 'deploy-provenance', 'outputs'])
    assert.match(ignored, new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

await test('container runs the isolated Node standalone output as an unprivileged user', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /npm run build:node/);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/dist-node\//);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
});
