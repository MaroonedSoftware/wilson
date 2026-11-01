// Applies the pending changesets, then copies the desktop app's version into the file the app is
// stamped from. `changeset version` knows only about package.json, and a C# build reads neither.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROPS = 'apps/desktop/Directory.Build.props';

execFileSync('pnpm', ['exec', 'changeset', 'version'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const props = readFileSync(PROPS, 'utf8');
const stamped = props.replace(/<Version>.*<\/Version>/, `<Version>${version}</Version>`);
if (!stamped.includes(`<Version>${version}</Version>`)) throw new Error(`no <Version> in ${PROPS}`);
writeFileSync(PROPS, stamped);
