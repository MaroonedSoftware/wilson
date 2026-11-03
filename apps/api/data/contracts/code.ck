options {
    services: {
        CodeService: "#modules/code/code.service.js"
    }
    security: {
        policy: wilson.view
    }
}

# Card 0005. Read a registered project's committed code: list a directory, read a file, search
# contents. Which project comes from the request's own project context (`ProjectContextRouter`,
# `ChatCatalog.run`), never from a path a caller supplies, so an unregistered one is already refused.
#
# Gated with `wilson.view`, which any session or key satisfies: Wilson has one account, so there is
# no per-project visibility to check (`access.policies.ts`). That means a `view` API key can read the
# source of every registered project, and that these reach MCP clients as well as the chat.
#
# Every read goes through git against one resolved commit, and every response names that commit,
# because nothing here fetches and a clone can lag its remote. See `code.reader.ts` for the limits,
# and `wilson.code_reads` for the record every read and refusal leaves.
contract CodeEntry: {
    name: string
    path: string
    type: enum(file, directory, symlink, submodule)
    # A file's size in bytes.
    size?: int
    # True for a name the deny list covers: shown, because the name is not the secret, but unreadable.
    denied?: boolean
}

contract CodeListing: {
    commit: string
    path: string
    entries: array(CodeEntry)
}

contract CodeFilePage: {
    commit: string
    path: string
    content: string
    # The 1-based line `content` starts on.
    offset: int
    totalLines: int
    # Where the next page starts; absent on the last one.
    nextOffset?: int
    # True when one line alone was over the page budget, so this page holds only the start of it.
    lineTruncated?: boolean
}

contract CodeMatch: {
    path: string
    line: int
    excerpt: string
}

contract CodeSearchResult: {
    commit: string
    matches: array(CodeMatch)
    # True when there were more matches than this holds, or an excerpt was cut.
    truncated: boolean
}

# `ref` on all three: a plain branch or tag name, `HEAD` of the project's code root when left out.
# Revision syntax and commit ids are refused.
contract CodeListQuery: {
    path?: string
    ref?: string
}

contract CodeReadQuery: {
    path: string
    ref?: string
    # The 1-based line to start from.
    offset?: int
    # How many lines, 400 when left out. A page also stops at its byte budget.
    limit?: int
}

contract CodeSearchQuery: {
    # An extended regular expression.
    pattern: string
    path?: string
    ref?: string
}

operation /api/code/tree: {
    get: {
        name: List project code
        service: CodeService.list
        query: CodeListQuery
        response: {
            200: {
                application/json: CodeListing
            }
            # `details.reason` says why: a bad path or ref, a denied path, or one not in the tree.
            400:
        }
    }
}

operation /api/code/file: {
    get: {
        name: Read project file
        service: CodeService.read
        query: CodeReadQuery
        response: {
            200: {
                application/json: CodeFilePage
            }
            # As `/api/code/tree`, and also a symlink, a binary file, or a blob over 5 MiB.
            400:
        }
    }
}

operation /api/code/search: {
    get: {
        name: Search project code
        service: CodeService.search
        query: CodeSearchQuery
        response: {
            200: {
                application/json: CodeSearchResult
            }
            # As `/api/code/tree`, and also a search that hit its time limit.
            400:
        }
    }
}
