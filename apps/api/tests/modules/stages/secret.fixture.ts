/**
 * Credential-shaped values for tests, built at runtime so that this repo's own source holds none and
 * no scanner, this one included, has anything to find in it. Random-looking, not random, so a failure
 * reproduces.
 */
const RANDOM = 'q7Rz2LmX9vKp4TwN8cYb3HsJ6dGf5AeU1oIr0ZnQkVtMxWyBhCjPlDgSaEuFi7Ko';
const RANDOM_CAPS = 'Q7RZ2LMX6VKP4TWN';
const BASE64_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7Vb3mXq9Lz2Rk';

const open = (type: string): string => `-----BEGIN ${type}PRIVATE KEY-----`;

export const fakeSecrets = {
    pemHeader: open('RSA '),
    pemBody: BASE64_BODY,
    github: `ghp_${RANDOM.slice(0, 36)}`,
    githubFineGrained: `github_pat_${RANDOM.slice(0, 22)}_${RANDOM.slice(2, 62)}`,
    aws: `AKIA${RANDOM_CAPS}`,
    awsTemporary: `ASIA${RANDOM_CAPS}`,
    anthropic: `sk-ant-api03-${RANDOM}${RANDOM.slice(0, 30)}`,
    openaiProject: `sk-proj-${RANDOM}`,
    openaiLegacy: `sk-${RANDOM.slice(0, 20)}${'T3Blbk'}FJ${RANDOM.slice(20, 40)}`,
};
