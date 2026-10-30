/**
 * `owner/name`, GitHub's own characters only: letters, digits, `.`, `_`, `-`, and exactly one `/`.
 * What stands between an operator's string and a GitHub URL or a folder name: a bad one must never
 * reach either.
 */
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
