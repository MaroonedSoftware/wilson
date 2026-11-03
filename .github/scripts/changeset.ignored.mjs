// Fails a pull request whose changesets name a package `.changeset/config.json` ignores. Changesets
// refuses to version a changeset that mixes ignored and released packages, and only says so after the
// merge, when `desktop-version.yml` fails and holds up every desktop release behind it. Runs before
// any install, so this reads the files itself rather than asking `changeset status`.
import { readdirSync, readFileSync } from 'node:fs';

const { ignore } = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));
const pending = readdirSync('.changeset').filter(name => name.endsWith('.md') && name !== 'README.md');

let failed = false;
for (const name of pending) {
    const path = `.changeset/${name}`;
    const frontMatter = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)^---/m)?.[1] ?? '';
    const packages = [...frontMatter.matchAll(/^\s*['"]?([^'":\s]+)['"]?\s*:/gm)].map(match => match[1]);
    const named = packages.filter(pkg => ignore.includes(pkg));
    if (named.length > 0) {
        failed = true;
        console.log(`::error file=${path}::${name} names ${named.join(', ')}, which changesets ignores. Name only @wilson/desktop.`);
    }
}

process.exit(failed ? 1 : 0);
