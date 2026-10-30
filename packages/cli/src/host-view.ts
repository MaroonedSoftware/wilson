import type { DateTime } from 'luxon';
import type { Host } from '@wilson/sdk';

/**
 * One host as `wilson host list` prints it: its name and how it is reached, its switches and slots, what the
 * last probe found, one indented line per slot in use, and one per project it serves.
 */
export const describeHost = (host: Host): string[] => {
    const state = !host.enabled ? 'disabled' : host.draining ? 'draining' : 'enabled';
    const target = host.kind === 'worker' ? ' (worker)' : host.sshTarget === host.name ? '' : ` (ssh ${host.sshTarget})`;
    const lifetime = host.lifetimeMinutes ? `  lives ${host.lifetimeMinutes}m after boot` : '';
    const commandEnv = host.commandEnv.length > 0 ? `  commands get ${host.commandEnv.join(', ')} from it` : '';
    const token = host.kind !== 'worker' ? '' : host.workerToken ? `  token …${host.workerToken.hint}` : '  no token yet';
    const lines = [
        `${host.name}${target}  ${state}  ${host.running.length}/${host.slots} slot${host.slots === 1 ? '' : 's'} in use${lifetime}${commandEnv}${token}  ${describeProbe(host)}`,
    ];
    for (const use of host.running) {
        lines.push(`  slot ${use.slot}: ${use.project} ${use.cardId} since ${utc(use.since)}`);
    }
    for (const project of host.projects) {
        lines.push(`  ${project.project}  ${project.codeRoot}  worktrees ${project.worktreeRoot}  run ${project.runRoot}`);
    }
    if (host.projectsRoot) lines.push(`  any project with a GitHub repository can add itself under ${host.projectsRoot}`);
    else if (host.projects.length === 0) lines.push('  serves no project yet: `wilson host serve` adds one');
    return lines;
};

const describeProbe = (host: Host): string => {
    const probe = host.probe;
    if (!probe) return 'never probed';
    const verdict = probe.ok ? 'ok' : `failed: ${probe.detail ?? 'no reason given'}`;
    const engine = probe.engineVersion ? `, claude ${probe.engineVersion}` : '';
    const expires = probe.expiresAt ? `, expires ${utc(probe.expiresAt)}` : '';
    return `probe ${verdict} at ${utc(probe.probedAt)}${engine}${expires}`;
};

/** `--command-env`'s comma-separated list as names, blanks dropped, so `--command-env ''` clears it. */
export const variableNames = (list: string): string[] =>
    list
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

/** A time as UTC ISO without milliseconds, so the output reads the same in every timezone. */
const utc = (at: DateTime): string => at.toUTC().toISO({ suppressMilliseconds: true }) ?? at.toString();
