import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const name = 'biplan-graph-prototype', image = 'neo4j@sha256:5eb12ad77fa46ab73e23df9ea1f43f5c0f2a79523435577648e046be042b9b93';
const dir = resolve(import.meta.dirname, '../../work/graph-20260929');
await mkdir(dir, { recursive: true });
let existing;
try { existing = JSON.parse((await exec('docker', ['inspect', name], { windowsHide: true })).stdout)[0]; } catch { /* No container */ }
if (existing) {
  if (existing.Config.Labels?.['biplan.experiment'] !== 'local-graph-v1') throw Error('Container name belongs to another task');
  await exec('docker', ['start', name], { windowsHide: true });
} else {
  await exec('docker', ['run', '-d', '--name', name, '--label', 'biplan.experiment=local-graph-v1',
    '--memory=2g', '--cpus=2', '-p', '127.0.0.1:17474:7474', '-p', '127.0.0.1:17687:7687',
    '-e', 'NEO4J_AUTH=none', '-e', 'NEO4J_server_memory_heap_initial__size=512m',
    '-e', 'NEO4J_server_memory_heap_max__size=768m', '-e', 'NEO4J_server_memory_pagecache_size=256m',
    '-v', 'biplan-graph-prototype-data:/data', image], { windowsHide: true });
}
const inspect = JSON.parse((await exec('docker', ['inspect', name], { windowsHide: true })).stdout)[0];
await writeFile(resolve(dir, 'container.json'), JSON.stringify({ name, image, imageId: inspect.Image, ports: inspect.HostConfig.PortBindings, memory: inspect.HostConfig.Memory, at: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ name, browser: 'http://127.0.0.1:17474', database: 'http://127.0.0.1:17474/db/neo4j/query/v2', localOnly: true }));
