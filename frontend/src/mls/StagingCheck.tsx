// Explicit diagnostic route for staging builds only. Uses synthetic identities,
// the real WASM transport and the platform vault; never logs keys or user data.
import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { invokeMLS } from './runtime';
import { withVault } from './vault';
import { b64 } from './encoding';
import { recordStagingCheck } from './stagingDiagnostics';
import type { Vault } from './types';

const allowed = process.env.EXPO_PUBLIC_APP_VARIANT === 'staging' || Constants.expoConfig?.extra?.appVariant === 'staging';
const users = ['mls_native_check_alice', 'mls_native_check_bob'];
async function identity(user: string) {
  return withVault(user, async (stored, save) => {
    let v = stored as (Vault & { smokeRuns?: number }) | null;
    if (!v) {
      v = { version: 1, device: { user_id: user, device_id: Crypto.randomUUID() }, master: b64(await Crypto.getRandomBytesAsync(32)), rooms: {}, verified: {} };
    }
    const result = await invokeMLS({ device: v.device, master: v.master, state: v.state || null, command: { op: 'identity' } });
    v.state = result.state;
    v.smokeRuns = (v.smokeRuns || 0) + 1;
    await save(v);
    return { identity: result.output, runs: v.smokeRuns };
  });
}
async function command(user: string, cmd: unknown) {
  return withVault(user, async (v, save) => {
    if (!v) throw new Error('Missing persisted test identity');
    const result = await invokeMLS({ device: v.device, master: v.master, state: v.state, command: cmd });
    v.state = result.state; await save(v); return result.output;
  });
}
async function check() {
  let alice: Awaited<ReturnType<typeof identity>> | undefined;
  // RuntimeHost initializes asynchronously when the app first mounts.
  for (let i = 0; i < 50; i++) {
    try { alice = await identity(users[0]); break; }
    catch (e) { if (!(e instanceof Error) || !e.message.includes('not ready')) throw e; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!alice) throw new Error('MLS runtime startup timeout');
  const bob = await identity(users[1]);
  const roster = [alice.identity.device, bob.identity.device];
  await command(users[0], { op: 'verify', peer: bob.identity });
  await command(users[1], { op: 'verify', peer: alice.identity });
  const pkg = await command(users[1], { op: 'key_package' });
  const conversation = 'native-check-' + Crypto.randomUUID();
  await command(users[0], { op: 'create', conversation });
  const added = await command(users[0], { op: 'add', conversation, packages: [pkg], roster });
  await command(users[0], { op: 'accept', conversation, roster });
  await command(users[1], { op: 'join', conversation, welcome: added.welcome, roster });
  const body = 'Synthetic native MLS exchange '.repeat(1800);
  const message = await command(users[0], { op: 'encrypt', conversation, body, roster });
  const received = await command(users[1], { op: 'receive', conversation, message, roster });
  if (received.body !== body) throw new Error('Native MLS exchange mismatch');
  return { status: 'PASS', platform: Platform.OS, persistedRuns: Math.min(alice.runs, bob.runs), bytes: body.length };
}
export default function StagingMLSCheck({ hidden = false }: { hidden?: boolean } = {}) {
  const [result, setResult] = useState('Running native MLS/storage check…');
  useEffect(() => {
    if (!allowed) return;
    void (async () => {
      let outcome: object;
      try { outcome = await check(); } catch (e) { outcome = { status: 'FAIL', error: e instanceof Error ? e.message : 'Native check failed' }; }
      const text = JSON.stringify(outcome);
      setResult(text);
      console.log('GHOSTEL_MLS_NATIVE_CHECK', text);
      await recordStagingCheck(text);
    })();
  }, []);
  if (hidden) return null;
  return <ScrollView style={{ flex: 1, backgroundColor: '#0f1419', padding: 28 }}><Text selectable style={{ color: 'white', fontSize: 18 }}>{allowed ? result : 'Not available'}</Text></ScrollView>;
}
