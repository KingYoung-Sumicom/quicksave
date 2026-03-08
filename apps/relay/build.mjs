import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = JSON.stringify(pkg.version);

execSync(
  `esbuild src/index.ts --bundle --platform=node --target=node20 --outfile=dist/bundle.cjs --format=cjs '--define:VERSION=${version}'`,
  { stdio: 'inherit' }
);
