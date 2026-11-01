// Applies the pending changesets, then copies the desktop app's version into the file the app is
// stamped from. `changeset version` knows only about package.json, and a C# build reads neither.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const PROPS = 'apps/desktop/Directory.Build.props';

// Merging the version pull request deletes the changesets, and that push starts this too.
// `changeset version` fails when it has nothing to apply.
const pending = readdirSync('.changeset').filter(name => name.endsWith('.md') && name !== 'README.md');
if (pending.length === 0) {
    console.log('No pending changesets.');
    process.exit(0);
}

execFileSync('pnpm', ['exec', 'changeset', 'version'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const props = readFileSync(PROPS, 'utf8');
const stamped = props.replace(/<Version>.*<\/Version>/, `<Version>${version}</Version>`);
if (!stamped.includes(`<Version>${version}</Version>`)) throw new Error(`no <Version> in ${PROPS}`);
writeFileSync(PROPS, stamped);
