import type { Host } from '@wilson/sdk';

/**
 * One host as `wilson host list` prints it: its name and target, its switches and slots, what the
 * last probe found, and one indented line per project it serves.
 */
export const describeHost = (host: Host): string[] => {
    const state = !host.enabled ? 'disabled' : host.draining ? 'draining' : 'enabled';
    const target = host.sshTarget === host.name ? '' : ` (ssh ${host.sshTarget})`;
    const lines = [`${host.name}${target}  ${state}  ${host.slots} slot${host.slots === 1 ? '' : 's'}  ${describeProbe(host)}`];
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
