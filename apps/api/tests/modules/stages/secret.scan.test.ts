import { describe, expect, it } from 'vitest';
import { scanAddedLines } from '#modules/stages/secret.scan.js';
import { fakeSecrets } from './secret.fixture.js';

const scanText = (...texts: string[]) =>
    scanAddedLines(
        'src/a.ts',
        texts.map((text, index) => ({ line: index + 10, text })),
    );

describe('scanAddedLines: detection', () => {
    it.each([
        ['GitHub token', fakeSecrets.github],
        ['GitHub token', fakeSecrets.githubFineGrained],
        ['AWS access key', fakeSecrets.aws],
        ['AWS access key', fakeSecrets.awsTemporary],
        ['Anthropic API key', fakeSecrets.anthropic],
        ['OpenAI API key', fakeSecrets.openaiProject],
        ['OpenAI API key', fakeSecrets.openaiLegacy],
    ])('finds a %s and locates it', (kind, value) => {
        expect(scanText('const safe = 1;', `const key = "${value}";`)).toEqual([{ path: 'src/a.ts', line: 11, kind }]);
    });

    it('finds a private key whose body is on the next added line', () => {
        expect(scanText(fakeSecrets.pemHeader, fakeSecrets.pemBody)).toEqual([{ path: 'src/a.ts', line: 10, kind: 'private key' }]);
    });

    it('steps over a legacy PEM header to reach the body', () => {
        const lines = [fakeSecrets.pemHeader, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,00', '', fakeSecrets.pemBody];
        expect(scanText(...lines).map(finding => finding.kind)).toEqual(['private key']);
    });

    it('finds a private key escaped into one string', () => {
        expect(scanText(`const pem = "${fakeSecrets.pemHeader}\\n${fakeSecrets.pemBody}\\n";`).map(finding => finding.kind)).toEqual(['private key']);
    });

    it('reports one finding for two values of a kind on a line, and one for each kind', () => {
        expect(scanText(`${fakeSecrets.github} ${fakeSecrets.github}`)).toHaveLength(1);
        expect(scanText(`${fakeSecrets.github} ${fakeSecrets.aws}`)).toHaveLength(2);
    });

    it('never returns the value, in any field', () => {
        const everything = Object.values(fakeSecrets);
        const serialized = JSON.stringify(scanText(...everything));
        expect(scanText(...everything).length).toBeGreaterThan(0);
        for (const value of everything) expect(serialized).not.toContain(value);
    });
});

describe('scanAddedLines: what it leaves alone', () => {
    it.each([
        ['a private key header in a parser', 'const isPem = text.startsWith("-----BEGIN PRIVATE KEY-----");'],
        ['the AWS documentation key', 'AKIAIOSFODNN7EXAMPLE'],
        ['a repeated character', `ghp_${'x'.repeat(36)}`],
        ['a repeated pattern', `AKIA${'AB'.repeat(8)}`],
        ['an ascending run', `ghp_${'1234567890abcdef'.repeat(3).slice(0, 36)}`],
        ['a named placeholder', `sk-ant-api03-your-key-goes-here-${'a1B2c3D4'.repeat(6)}`],
        ['a word that merely ends in sk-', `task-${fakeSecrets.openaiProject.slice(3)}`],
        ['a key too short for its format', 'ghp_q7Rz2LmX9vKp'],
        ['an AWS prefix inside a longer word', `X${fakeSecrets.aws}`],
        ['a commit sha', 'dace9672c0a1b2c3d4e5f60718293a4b5c6d7e8f'],
    ])('%s', (_name, text) => {
        expect(scanText(text)).toEqual([]);
    });

    it('does not take base64 far below a header, or across a gap in the added lines, as its body', () => {
        const far = [fakeSecrets.pemHeader, 'a', 'b', 'c', 'd', fakeSecrets.pemBody];
        expect(scanText(...far)).toEqual([]);

        const gap = [
            { line: 1, text: fakeSecrets.pemHeader },
            { line: 40, text: fakeSecrets.pemBody },
        ];
        expect(scanAddedLines('a.pem', gap)).toEqual([]);
    });
});
