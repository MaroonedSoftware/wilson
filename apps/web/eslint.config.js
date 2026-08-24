//  @ts-check

import base from '@repo/config-eslint/base.js';

/** @type {import("eslint").Linter.Config[]} */
export default [
    ...base,
    // PostCSS loads its config with require(), so it stays CommonJS in an ESM package and trips
    // no-undef on `module`. Twelve lines of Mantine breakpoints are not worth a globals block.
    { ignores: ['postcss.config.cjs'] },
];
