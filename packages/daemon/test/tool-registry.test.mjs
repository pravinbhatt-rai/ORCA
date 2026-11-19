import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_IMPLEMENTATION_NAMES, BUILTIN_TOOL_SPECS, DEFAULT_TOOL_REGISTRY, ToolRegistry } from '../src/tool-registry.mjs';

test('built-in registry exposes validated executable schemas and truthful availability', async () => {
  assert.equal(DEFAULT_TOOL_REGISTRY.list().length, BUILTIN_TOOL_SPECS.length);
  assert.equal(DEFAULT_TOOL_REGISTRY.get('fs.read').availability, 'catalog-only');
  const runtimeRegistry = new ToolRegistry(BUILTIN_TOOL_SPECS, Object.fromEntries(BUILTIN_IMPLEMENTATION_NAMES.map(name => [name, async () => ({})])));
  assert.equal(runtimeRegistry.get('fs.read').availability, 'executable');
  assert.equal(DEFAULT_TOOL_REGISTRY.get('future.tool'), null);
  assert.throws(() => DEFAULT_TOOL_REGISTRY.validate('fs.read', {}), /path is required/);
  assert.throws(() => DEFAULT_TOOL_REGISTRY.validate('fs.read', { path: 'a', extra: true }), /not allowed/);
  assert.throws(() => new ToolRegistry([BUILTIN_TOOL_SPECS[0], BUILTIN_TOOL_SPECS[0]], {}), /Duplicate tool/);
  const unavailable = new ToolRegistry([BUILTIN_TOOL_SPECS[0]], {});
  assert.equal(unavailable.get('fs.read').availability, 'catalog-only');
  await assert.rejects(unavailable.execute('fs.read', { path: 'x' }), /unavailable/);
  let executed = false;
  const guarded = new ToolRegistry([BUILTIN_TOOL_SPECS[0]], { 'fs.read': async () => { executed = true; return { path: 'x', content: 'ok' }; } });
  await assert.rejects(guarded.execute('fs.read', {}), /path is required/);
  assert.equal(executed, false, 'invalid arguments must be rejected before implementation execution');
});

test('registry validates implementation results against output schemas', async () => {
  const spec = { name: 'sample.read', description: 'sample', tier: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
  const registry = new ToolRegistry([spec], { 'sample.read': async () => ({ value: 4 }) });
  await assert.rejects(registry.execute('sample.read', {}), /not authorized/);
  const { grant } = registry.authorize('sample.read', {}, { mode: 'allow' });
  await assert.rejects(registry.execute('sample.read', {}, { authorization: grant }), /result.value must be string/);
  await assert.rejects(registry.execute('sample.read', {}, { authorization: grant }), /not authorized/);
});

test('registry binds execution grants to policy and exact arguments', async () => {
  const spec = { name: 'sample.write', description: 'sample', tier: 'write', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
  let executions = 0;
  const registry = new ToolRegistry([spec], { 'sample.write': async ({ value }) => { executions++; return { value }; } });
  assert.throws(() => registry.authorize('sample.write', { value: 'x' }, { mode: 'deny' }), /denied/);
  assert.throws(() => registry.authorize('sample.write', { value: 'x' }, { mode: 'ask' }), /approval is missing/);
  const args = { value: 'reviewed' }, argsHash = (await import('../src/core.mjs')).hashArgs(args);
  const { grant } = registry.authorize('sample.write', args, { mode: 'ask', approval: { approvalId: 'approval-1', status: 'approved', argsHash } });
  await assert.rejects(registry.execute('sample.write', { value: 'changed' }, { authorization: grant }), /not authorized/);
  assert.equal(executions, 0);
  await registry.execute('sample.write', args, { authorization: grant });
  assert.equal(executions, 1);
});
