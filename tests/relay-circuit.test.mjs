import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTsetmcViaHosts, relayHostAvailable, recordRelayHostResult } from '../app/api/tsetmc-relay/route.ts';
import real from './fixtures/phase2-real-samples.json' with { type: 'json' };

test('relay isolates a failing official host and uses the healthy alternative', async () => {
  const primary = 'cdn.tsetmc.com', secondary = 'tsetmc.com';
  recordRelayHostResult(primary, true);
  recordRelayHostResult(secondary, true);
  const calls = [];
  const request = async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    return host === primary ? new Response('blocked', { status: 503 }) : Response.json({ valid: true });
  };
  const path = 'ClosingPrice/GetClosingPriceInfo/123';
  assert.deepEqual(JSON.parse(await fetchTsetmcViaHosts(path, undefined, undefined, request)), { valid: true });
  assert.deepEqual(JSON.parse(await fetchTsetmcViaHosts(path, undefined, undefined, request)), { valid: true });
  assert.equal(relayHostAvailable(primary), false);
  calls.length = 0;
  assert.deepEqual(JSON.parse(await fetchTsetmcViaHosts(path, undefined, undefined, request)), { valid: true });
  assert.deepEqual(calls, [secondary]);
  recordRelayHostResult(primary, true);
  recordRelayHostResult(secondary, true);
});

test('both failed official hosts return unavailable without a false successful JSON response', async () => {
  recordRelayHostResult('cdn.tsetmc.com', true);
  recordRelayHostResult('tsetmc.com', true);
  const request = async () => new Response('unavailable', { status: 502 });
  assert.equal(await fetchTsetmcViaHosts('Instrument/GetInstrumentInfo/456', undefined, undefined, request), null);
  assert.equal(await fetchTsetmcViaHosts('Instrument/GetInstrumentInfo/456', undefined, undefined, request), null);
  assert.equal(relayHostAvailable('cdn.tsetmc.com'), false);
  assert.equal(relayHostAvailable('tsetmc.com'), false);
  recordRelayHostResult('cdn.tsetmc.com', true);
  recordRelayHostResult('tsetmc.com', true);
});

test('wrong-session HTTP 200 does not mask authentic dated ClientType and floor from alternate host', async () => {
  const sample = real.samples[1];
  const primary = 'cdn.tsetmc.com', secondary = 'tsetmc.com';
  recordRelayHostResult(primary, true);
  recordRelayHostResult(secondary, true);
  const calls = [];
  for (const [path, actual, invalid] of [
    [`ClientType/GetClientTypeHistory/${sample.code}/${real.session}`, sample.client, { clientType: { ...sample.client.clientType, recDate: 20261006 } }],
    [`MarketData/GetStaticThreshold/${sample.code}/${real.session}`, sample.floor, { staticThreshold: [] }],
  ]) {
    const result = await fetchTsetmcViaHosts(path, undefined, undefined, async url => {
      calls.push(new URL(url).hostname);
      return Response.json(new URL(url).hostname === primary ? invalid : actual);
    });
    assert.deepEqual(JSON.parse(result), actual);
  }
  assert.deepEqual(calls, [primary, secondary, primary, secondary]);
  assert.equal(relayHostAvailable(primary), true, 'missing session for one symbol must not poison host health');
  recordRelayHostResult(primary, true);
  recordRelayHostResult(secondary, true);
});

test('HTTP 200 with no same-session official ClientType/floor remains unavailable', async () => {
  const sample = real.samples[0];
  recordRelayHostResult('cdn.tsetmc.com', true);
  recordRelayHostResult('tsetmc.com', true);
  const paths = [
    [`ClientType/GetClientTypeHistory/${sample.code}/${real.session}`, { clientType: null }],
    [`MarketData/GetStaticThreshold/${sample.code}/${real.session}`, { staticThreshold: [] }],
  ];
  for (const [path, empty] of paths)
    assert.equal(await fetchTsetmcViaHosts(path, undefined, undefined, async () => Response.json(empty)), null);
  recordRelayHostResult('cdn.tsetmc.com', true);
  recordRelayHostResult('tsetmc.com', true);
});
