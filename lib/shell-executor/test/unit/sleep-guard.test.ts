import { describe, it } from 'mocha';
import { expect } from 'chai';
import { detectLongSleep, SLEEP_GUARD_THRESHOLD_S } from '../../src/sleep-guard.js';

describe('sleep-guard — detectLongSleep', () => {
  describe('refuses commands that wait by sleeping', () => {
    const cases: Array<[string, number]> = [
      ['sleep 600', 600],
      ['sleep 900 && kubectl rollout status deploy/api', 900],
      ['npm test; sleep 30; cat /tmp/out', 30],
      ['sleep 5m', 300],
      ['sleep 1.5h', 5400],
      ['sleep 1m 30s', 90],
      ['/bin/sleep 120', 120],
      ['echo started && sleep 60 || true', 60],
      ['make build | tee log & sleep 45', 45],
      ['x=$(sleep 20; echo done)', 20],
      ['x=`sleep 20`', 20],
      ['timeout 700 sleep 600', 600],
      ['timeout -s KILL 700 sleep 600', 600],
      ['for i in 1 2 3; do sleep 30; done', 30],
      ['if true; then sleep 15; fi', 15],
      ['FOO=bar sleep 20', 20],
      ['nohup sleep 60', 60],
      ['sleep 8; sleep 8', 16],
      ['sleep infinity', Number.POSITIVE_INFINITY],
      ['curl localhost:3000\nsleep 300\ncurl localhost:3000', 300],
    ];
    for (const [command, seconds] of cases) {
      it(`detects ${JSON.stringify(command)} as ${seconds}s [unit]`, () => {
        expect(detectLongSleep(command)).to.equal(seconds);
      });
    }
  });

  describe('allows short pauses and non-sleep commands', () => {
    const cases = [
      'ls -la',
      'sleep 2 && curl localhost:3000',
      `sleep ${SLEEP_GUARD_THRESHOLD_S}`,
      'sleep 5; sleep 5',
      'echo "sleep 600"',
      "grep 'sleep 600' notes.txt",
      'sleepy 600',
      'npm run sleep-report',
      'git commit -m "wait: sleep 600 was too long"',
      'sleep',
      'sleep abc',
    ];
    for (const command of cases) {
      it(`allows ${JSON.stringify(command)} [unit]`, () => {
        expect(detectLongSleep(command)).to.equal(null);
      });
    }
  });

  describe('known blind spots (accepted in the design)', () => {
    it('does not see a sleep inside an interpreter one-liner [unit]', () => {
      expect(detectLongSleep(`python -c 'import time; time.sleep(600)'`)).to.equal(null);
    });

    it('does not see a sleep hidden in a quoted bash -c script [unit]', () => {
      expect(detectLongSleep(`bash -c "sleep 600"`)).to.equal(null);
    });
  });
});
