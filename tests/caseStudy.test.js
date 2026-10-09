'use strict';

/**
 * Phase 5 acceptance - the full SRS Section 6 case study re-seeded from
 * scratch and asserted by scripts/verifyCaseStudy.js (87 assertions).
 * This test simply proves `npm test` and `npm run verify` agree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

test('Section 6 case study passes every verification assertion', { timeout: 180000 }, () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'verifyCaseStudy.js')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 170000,
  });

  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  assert.equal(run.status, 0, `verifyCaseStudy.js failed:\n${output}`);

  assert.match(output, /87\/87 assertions passed/);
  assert.match(output, /Trial balance balanced {2,}: YES/);
  assert.match(output, /Balance sheet balanced {2,}: YES/);

  // The three figures the SRS prints incorrectly (see docs/DEVIATIONS.md).
  assert.match(output, /bank balance\s+doc \$49,400\.00 -> engine \$48,400\.00/);
  assert.match(output, /trial balance\s+doc \$91,283\.33 -> engine \$90,283\.33/);
  assert.match(output, /total assets\s+doc \$71,766\.67 -> engine \$70,766\.67/);
});
