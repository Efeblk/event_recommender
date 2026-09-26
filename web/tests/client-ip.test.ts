import assert from 'node:assert/strict';
import test from 'node:test';

import { clientIp } from '../lib/client-ip.node.ts';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://service.run.app/api', { headers });
}

const direct = { BIPLAN_CLIENT_IP_MODE: 'cloud-run-direct' };

void test('defaults to one shared bucket and fails closed for unknown modes', () => {
  const headers = {
    'cf-connecting-ip': '198.51.100.9',
    'x-forwarded-for': '192.0.2.1',
  };
  assert.equal(clientIp(request(headers), {}), 'shared');
  assert.equal(clientIp(request(headers), { BIPLAN_CLIENT_IP_MODE: 'shared' }), 'shared');
  assert.equal(clientIp(request(headers), { BIPLAN_CLIENT_IP_MODE: 'typo' }), 'shared');
});

void test('direct Cloud Run mode trusts only the rightmost appended address', () => {
  assert.equal(
    clientIp(
      request({
        'cf-connecting-ip': '203.0.113.99',
        'x-forwarded-for': '203.0.113.88, 198.51.100.7',
      }),
      direct,
    ),
    '198.51.100.7',
  );
});

void test('an invalid rightmost value fails closed instead of using spoofable values', () => {
  assert.equal(
    clientIp(
      request({
        'cf-connecting-ip': '192.0.2.2',
        'x-forwarded-for': '192.0.2.1, attacker.example',
      }),
      direct,
    ),
    'shared',
  );
  assert.equal(clientIp(request(), direct), 'shared');
});

void test('rejects ambiguous IPv4 spellings, ports, zones, and oversized chains', () => {
  for (const value of ['192.168.001.1', '256.1.1.1', '192.0.2.1:443', '[::1]', 'fe80::1%eth0']) {
    assert.equal(clientIp(request({ 'x-forwarded-for': value }), direct), 'shared');
  }
  assert.equal(
    clientIp(request({ 'x-forwarded-for': Array(33).fill('192.0.2.1').join(',') }), direct),
    'shared',
  );
});

void test('canonicalizes equivalent IPv6 forms', () => {
  const expanded = clientIp(
    request({ 'x-forwarded-for': '2001:0DB8:0000:0000:0000:0000:0000:0001' }),
    direct,
  );
  const compressed = clientIp(request({ 'x-forwarded-for': '2001:db8::1' }), direct);
  assert.equal(expanded, '2001:db8::1');
  assert.equal(compressed, expanded);
});

void test('canonicalizes IPv4-mapped IPv6 to the same identity as IPv4', () => {
  const ipv4 = clientIp(request({ 'x-forwarded-for': '192.0.2.1' }), direct);
  assert.equal(
    clientIp(request({ 'x-forwarded-for': '::ffff:192.0.2.1' }), direct),
    ipv4,
  );
  assert.equal(clientIp(request({ 'x-forwarded-for': '::FFFF:C000:0201' }), direct), ipv4);
});
