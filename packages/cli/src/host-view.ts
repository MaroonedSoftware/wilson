import type { Host } from '@wilson/sdk';

/**
 * One host as `wilson host list` prints it: its name and target, its switches and slots, what the
 * last probe found, one indented line per slot in use, and one per project it serves.
 */
export const describeHost = (host: Host): string[] => {
    const state = !host.enabled ? 'disabled' : host.draining ? 'draining' : 'enabled';
    const target = host.sshTarget === host.name ? '' : ` (ssh ${host.sshTarget})`;
    const lifetime = host.lifetimeMinutes ? `  lives ${host.lifetimeMinutes}m after boot` : '';
    const lines = [
        `${host.name}${target}  ${state}  ${host.running.length}/${host.slots} slot${host.slots === 1 ? '' : 's'} in use${lifetime}  ${describeProbe(host)}`,
    ];
    for (const use of host.running) {
        lines.push(`  slot ${use.slot}: ${use.project} ${use.cardId} since ${use.since}`);
    }
    for (const project of host.projects) {
        lines.push(`  ${project.project}  ${project.codeRoot}  worktrees ${project.worktreeRoot}  run ${project.runRoot}`);
    }
    if (host.projects.length === 0) lines.push('  serves no project yet: `wilson host serve` adds one');
    return lines;
};

const describeProbe = (host: Host): string => {
    const probe = host.probe;
    if (!probe) return 'never probed';
    const verdict = probe.ok ? 'ok' : `failed: ${probe.detail ?? 'no reason given'}`;
    const engine = probe.engineVersion ? `, claude ${probe.engineVersion}` : '';
    const expires = probe.expiresAt ? `, expires ${probe.expiresAt}` : '';
    return `probe ${verdict} at ${probe.probedAt}${engine}${expires}`;
};
