import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const out = path.join(root, `bastion-pilot-extension-v${pkg.version}.zip`);

fs.rmSync(out, { force: true });
execFileSync('zip', ['-rq', out, '.'], { cwd: dist });
console.log('packaged', out);
