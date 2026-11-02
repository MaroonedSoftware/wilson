namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>What the new-project form works out, by the web app's `lib/projects.ts`.</summary>
public static class ProjectPaths
{
    /// <summary>
    /// `parent/.worktrees/name` and `parent/.run/name`, beside the repo, so two repos under one parent
    /// never share one. Nothing at all until there is a name and an absolute code root, as a
    /// half-derived path is worse than an empty field.
    /// </summary>
    public static (string WorktreeRoot, string RunRoot) Defaults(string? name, string? codeRoot)
    {
        var trimmed = name?.Trim() ?? string.Empty;
        var root = (codeRoot?.Trim() ?? string.Empty).TrimEnd('/');
        if (trimmed.Length == 0 || !root.StartsWith('/'))
        {
            return (string.Empty, string.Empty);
        }

        var parent = root[..root.LastIndexOf('/')];
        return ($"{parent}/.worktrees/{trimmed}", $"{parent}/.run/{trimmed}");
    }

    /// <summary>A folder's own name, which a new project takes if it has none yet.</summary>
    public static string LastSegment(string path)
    {
        ArgumentNullException.ThrowIfNull(path);

        return path[(path.LastIndexOf('/') + 1)..];
    }

    /// <summary>The folder above, stopping at the root.</summary>
    public static string Parent(string path)
    {
        ArgumentNullException.ThrowIfNull(path);

        var trimmed = path.TrimEnd('/');
        var cut = trimmed.LastIndexOf('/');
        return cut <= 0 ? "/" : trimmed[..cut];
    }

    /// <summary>A folder named from the one it is in.</summary>
    public static string Child(string path, string name) => path == "/" ? $"/{name}" : $"{path}/{name}";
}
