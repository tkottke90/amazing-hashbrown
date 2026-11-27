import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Counter, Registry } from '@prometheus-io/client';
import { scrapeTelemetryHandler } from './telemetry.handlers.js';

function registryWithCounter(): Registry {
  const registry = new Registry();
  new Counter({ name: 'hashbrown_test_total', help: 'test', registers: [registry] }).inc(3);
  return registry;
}

describe('routes/telemetry.handlers', () => {
  it('answers 404 while telemetry is disabled [orchestration]', async () => {
    const result = await scrapeTelemetryHandler({
      isEnabled: () => false,
      getRegistry: () => registryWithCounter(),
    });
    expect(result).to.deep.include({ ok: false, status: 404 });
  });

  it('does not touch the registry while telemetry is disabled [orchestration]', async () => {
    let touched = false;
    await scrapeTelemetryHandler({
      isEnabled: () => false,
      getRegistry: () => {
        touched = true;
        return registryWithCounter();
      },
    });
    expect(touched, 'a disabled endpoint must not read any store').to.equal(false);
  });

  it('returns the registry output with its Prometheus content type when enabled [orchestration]', async () => {
    const registry = registryWithCounter();
    const result = await scrapeTelemetryHandler({
      isEnabled: () => true,
      getRegistry: () => registry,
    });
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.data.contentType).to.equal(registry.contentType);
    expect(result.data.body).to.include('hashbrown_test_total 3');
  });
});
