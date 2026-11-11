import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { buildCandidate, decodeUnsigned, digest, encodeUnsigned, rehearse } from './package.mjs';

const [command, planPath, out, ...extra] = process.argv.slice(2);
try {
  if (!['prepare', 'rehearse'].includes(command) || !planPath || extra.length || (command === 'prepare' && !out) || (command === 'rehearse' && out)) {
    throw new Error('Usage: npm run release:prepare -- PLAN OUTPUT or npm run release:rehearse -- PLAN');
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const candidate = buildCandidate(plan, { cache: process.env.QFCA_NPM_CACHE }), bytes = encodeUnsigned(candidate);
  decodeUnsigned(bytes);
  if (command === 'prepare') {
    const fd = openSync(out, 'wx', 0o600); try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    console.log(JSON.stringify({ kind: 'unsigned-candidate', sha256: digest(bytes), bytes: bytes.length, productionEnabled: false }));
  } else {
    const second = encodeUnsigned(buildCandidate(plan, { cache: process.env.QFCA_NPM_CACHE }));
    if (!bytes.equals(second)) throw new Error('non-reproducible-build');
    console.log(JSON.stringify({ reproducible: true, transportSha256: digest(bytes), ...rehearse(candidate) }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
