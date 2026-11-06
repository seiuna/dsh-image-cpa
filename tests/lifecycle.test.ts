import { describe, expect, it } from 'vitest';
import { apply, name } from '../src/index';

interface FakeContext {
  tools: { register(definition: unknown): (() => void) | void };
  get(service: string): unknown;
  effect(callback: () => void | (() => void), label?: string): void;
}

interface FakeHarness {
  ctx: FakeContext;
  registrations: string[];
  disposers: Array<() => void>;
  effects: Array<() => void>;
  definitions: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>;
}

function fakeContext(options: { credentialValue?: string; attachments?: unknown } = {}): FakeHarness {
  const registrations: string[] = [];
  const disposers: Array<() => void> = [];
  const effects: Array<() => void> = [];
  const definitions: FakeHarness['definitions'] = [];
  const ctx: FakeContext = {
    tools: {
      register(definition: unknown) {
        const toolName = (definition as { name: string }).name;
        if (registrations.includes(toolName)) throw new Error(`tool "${toolName}" is already registered`);
        registrations.push(toolName);
        definitions.push(definition as FakeHarness['definitions'][number]);
        const dispose = (): void => {
          const index = registrations.indexOf(toolName);
          if (index >= 0) registrations.splice(index, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    get(service: string) {
      if (service === 'credentials') {
        return { resolve: async () => (options.credentialValue === undefined ? undefined : { value: options.credentialValue }) };
      }
      if (service === 'attachments') return options.attachments;
      return undefined;
    },
    effect(callback: () => void | (() => void)) {
      const disposer = callback();
      if (typeof disposer === 'function') effects.push(disposer);
    },
  };
  return { ctx, registrations, disposers, effects, definitions };
}

const EXEC = { callId: 'c1', name: 'x', arguments: {}, signal: new AbortController().signal };

describe('plugin lifecycle', () => {
  it('registers exactly the three documented tool names', () => {
    const harness = fakeContext();
    apply(harness.ctx as never, {});
    expect(harness.registrations.sort()).toEqual(['cpa_image_edit', 'cpa_image_generate', 'cpa_image_status']);
    expect(name).toBe('dsh-cpa-image');  });

  it('registers nothing when disabled', () => {
    const harness = fakeContext();
    apply(harness.ctx as never, { enabled: false });
    expect(harness.registrations).toHaveLength(0);
  });

  it('unregisters every tool when the plugin unloads', () => {
    const harness = fakeContext();
    apply(harness.ctx as never, {});
    expect(harness.registrations).toHaveLength(3);
    for (const dispose of harness.effects) dispose();
    expect(harness.registrations).toHaveLength(0);
  });

  it('can be re-applied after a reload without a duplicate-name failure', () => {
    const harness = fakeContext();
    apply(harness.ctx as never, {});
    for (const dispose of harness.effects) dispose();
    expect(() => apply(harness.ctx as never, {})).not.toThrow();
    expect(harness.registrations).toHaveLength(3);
  });

  it('rolls back a partial registration when a later tool throws', () => {
    const harness = fakeContext();
    let calls = 0;
    harness.ctx.tools.register = (definition: unknown) => {
      calls += 1;
      if (calls === 3) throw new Error('boom');
      harness.registrations.push((definition as { name: string }).name);
      return () => {
        harness.registrations.length = 0;
      };
    };
    expect(() => apply(harness.ctx as never, {})).toThrow(/boom/);
    expect(harness.registrations).toHaveLength(0);
  });

  it('rejects an invalid configuration with a stable message', () => {
    const harness = fakeContext();
    expect(() => apply(harness.ctx as never, { timeoutMs: 10 })).toThrow(/timeoutMs/);
    expect(() => apply(harness.ctx as never, { baseUrl: 'ftp://example.com' })).toThrow(/http/);
  });
});

describe('credential handling', () => {
  it('reports NOT_CONFIGURED when no CPA credential is stored, without echoing a secret', async () => {
    const harness = fakeContext();
    apply(harness.ctx as never, {});
    const status = harness.definitions.find(definition => definition.name === 'cpa_image_status')!;
    const value = await status.execute({}, EXEC) as { reachable: boolean; notes: string[] };
    expect(value.reachable).toBe(false);
    expect(value.notes.join(' ')).toContain('NOT_CONFIGURED');
    expect(value.notes.join(' ')).toContain('CPA_API_KEY');
  });
});
