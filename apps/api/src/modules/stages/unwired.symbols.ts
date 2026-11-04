import ts from 'typescript';
import { gitGrep, gitOn } from '#modules/board/git.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { isAssertionTestFile } from './assertion.delta.js';

/** More than this and the scan gives up: a diff this size is not one where a list like this gets read. */
const MAX_SCANNED_FILES = 200;
const MAX_LOOKUPS = 300;

const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
/**
 * Files whose exports are found by something other than an import: a package's entry point, a
 * framework's file-based routes, a migration runner, a tool's config. Listing them would only be wrong.
 */
const FOUND_WITHOUT_AN_IMPORT = /\.d\.[cm]?ts$|(^|\/)index\.[cm]?tsx?$|(^|\/)(routes|migrations)\/|\.config\.[cm]?ts$|\.stories\.tsx?$/;
const TEST_TREE = /(^|\/)(tests?|__tests__|__mocks__)\//;

/** Where a reference does not count: tests prove nothing is wired, and a doc mentioning it wires nothing. */
const NOT_A_REFERENCE = [
    ':(exclude,glob)**/*.test.*',
    ':(exclude,glob)**/*.spec.*',
    ':(exclude,glob)**/test/**',
    ':(exclude,glob)**/tests/**',
    ':(exclude,glob)**/__tests__/**',
    ':(exclude,glob)**/__mocks__/**',
    ':(exclude,glob)**/*.md',
];

/** One name a file exports. */
export interface ExportedSymbol {
    name: string;
    line: number;
    /** Whether the file itself uses it, beyond declaring and exporting it. */
    usedInFile: boolean;
}

/** A new export nothing appears to reach. */
export interface UnwiredSymbol {
    name: string;
    file: string;
    line: number;
}

export const isExportScanned = (path: string): boolean =>
    SOURCE_FILE.test(path) && !isAssertionTestFile(path) && !TEST_TREE.test(path) && !FOUND_WITHOUT_AN_IMPORT.test(path);

const scriptKind = (path: string): ts.ScriptKind => (path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean => ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false;

const bindingIdentifiers = (name: ts.BindingName): ts.Identifier[] =>
    ts.isIdentifier(name) ? [name] : name.elements.flatMap(element => (ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []));

/**
 * The names `source` exports by declaring them or listing them.
 *
 * Left out on purpose: a default export, which has no name to look for, and a re-export, which is
 * itself the reference to a symbol declared elsewhere. The parser recovers from a syntax error rather
 * than throwing.
 */
export const scanExports = (path: string, source: string): ExportedSymbol[] => {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
    /** Local name to exported names, and the identifiers that declare rather than use. */
    const exported = new Map<string, { name: string; position: number }[]>();
    const declaring = new Set<ts.Node>();

    const add = (local: string, name: string, node: ts.Node) => {
        exported.set(local, [...(exported.get(local) ?? []), { name, position: node.getStart(file) }]);
    };

    for (const statement of file.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
            for (const element of statement.exportClause.elements) {
                declaring.add(element.name);
                if (element.propertyName) declaring.add(element.propertyName);
                if (element.name.text !== 'default') add((element.propertyName ?? element.name).text, element.name.text, element);
            }
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
            for (const declaration of statement.declarationList.declarations) {
                for (const identifier of bindingIdentifiers(declaration.name)) {
                    // Declared and exported on separate lines still declares here.
                    declaring.add(identifier);
                    if (isExported) add(identifier.text, identifier.text, identifier);
                }
            }
            continue;
        }
        if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement) ||
                ts.isModuleDeclaration(statement)) &&
            statement.name &&
            ts.isIdentifier(statement.name)
        ) {
            declaring.add(statement.name);
            if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
                add(statement.name.text, statement.name.text, statement.name);
            }
        }
    }

    const used = new Set<string>();
    const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && !declaring.has(node) && exported.has(node.text)) used.add(node.text);
        ts.forEachChild(node, walk);
    };
    walk(file);

    const symbols = new Map<string, ExportedSymbol>();
    for (const [local, names] of exported) {
        for (const { name, position } of names) {
            // An overload or a merged declaration is one name; the first says where.
            if (symbols.has(name)) continue;
            symbols.set(name, { name, line: file.getLineAndCharacterOfPosition(position).line + 1, usedInFile: used.has(local) });
        }
    }
    return [...symbols.values()];
};

/** `git diff --name-status -z` is status, path, status, path. Renames are off, so there is always one path. */
const parseNameStatus = (stdout: string): { status: string; path: string }[] => {
    const fields = stdout.split('\0').filter(Boolean);
    const entries: { status: string; path: string }[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) entries.push({ status: fields[index]!, path: fields[index + 1]! });
    return entries;
};

const showFile = async (host: ExecutionHost, cwd: string, commit: string, path: string): Promise<string> =>
    (await gitOn(host, cwd, ['show', `${commit}:${path}`])).stdout;

/**
 * The exports this branch adds, against `baseSha`, that nothing appears to reach: named in no other
 * file outside tests and docs, and not used in their own file either.
 *
 * Fails toward silence. Anything uncertain leaves a symbol off, including a symbol a changed file
 * exported at the base, so a move is not an addition, and one whose lookup failed. It throws only when
 * the branch's diff itself cannot be read, or is too large to scan.
 *
 * Reads the two commits on the host. Only the lookup reads the working tree, so it also sees what a
 * stage left untracked.
 */
export const findUnwiredSymbols = async (host: ExecutionHost, cwd: string, baseSha: string): Promise<UnwiredSymbol[]> => {
    const { stdout } = await gitOn(host, cwd, ['diff', '--no-renames', '--name-status', '-z', baseSha, 'HEAD', '--']);
    const changed = parseNameStatus(stdout).filter(entry => SOURCE_FILE.test(entry.path));
    const scanned = changed.filter(entry => entry.status !== 'D' && isExportScanned(entry.path));
    if (scanned.length > MAX_SCANNED_FILES) throw new Error(`the diff has ${scanned.length} source files to scan, more than ${MAX_SCANNED_FILES}`);

    const atBase = new Set<string>();
    for (const entry of changed) {
        if (entry.status === 'A') continue;
        const source = await showFile(host, cwd, baseSha, entry.path).catch(() => undefined);
        if (source === undefined) continue;
        for (const symbol of scanExports(entry.path, source)) atBase.add(symbol.name);
    }

    const candidates: UnwiredSymbol[] = [];
    for (const entry of scanned) {
        const source = await showFile(host, cwd, 'HEAD', entry.path).catch(() => undefined);
        if (source === undefined) continue;
        for (const { name, line, usedInFile } of scanExports(entry.path, source)) {
            if (!usedInFile && !atBase.has(name)) candidates.push({ name, file: entry.path, line });
        }
    }
    if (candidates.length > MAX_LOOKUPS) throw new Error(`the diff adds ${candidates.length} exports to look up, more than ${MAX_LOOKUPS}`);

    const unwired: UnwiredSymbol[] = [];
    for (const candidate of candidates) {
        const references = await gitGrep(host, cwd, candidate.name, [`:(exclude,literal)${candidate.file}`, ...NOT_A_REFERENCE]).catch(
            () => undefined,
        );
        if (references?.length === 0) unwired.push(candidate);
    }
    return unwired;
};
