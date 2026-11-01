using System.Globalization;
using System.Text.RegularExpressions;

namespace MaroonedSoftware.Wilson.Desktop.Core.Diff;

public enum PatchLineKind
{
    Hunk,
    Context,
    Added,
    Removed,

    /// <summary>Git's own remark, such as a missing final newline or a binary file.</summary>
    Note,
}

/// <summary>One line of a patch, with its number on each side where it has one.</summary>
public sealed record PatchLine(PatchLineKind Kind, string Text, int? OldNumber = null, int? NewNumber = null);

/// <summary>
/// Reads one file's unified patch into lines to draw. The file's own header is dropped, because the
/// path is already on screen. Pure, because line numbers are easy to get subtly wrong.
/// </summary>
public static partial class Patch
{
    public static IReadOnlyList<PatchLine> Parse(string patch)
    {
        ArgumentNullException.ThrowIfNull(patch);

        List<PatchLine> lines = [];
        var inHunk = false;
        var oldNumber = 0;
        var newNumber = 0;

        foreach (var line in patch.Split('\n'))
        {
            if (Hunk().Match(line) is { Success: true } hunk)
            {
                inHunk = true;
                oldNumber = int.Parse(hunk.Groups[1].Value, CultureInfo.InvariantCulture);
                newNumber = int.Parse(hunk.Groups[2].Value, CultureInfo.InvariantCulture);
                lines.Add(new PatchLine(PatchLineKind.Hunk, line));
            }
            else if (!inHunk)
            {
                if (line.StartsWith("Binary files", StringComparison.Ordinal))
                {
                    lines.Add(new PatchLine(PatchLineKind.Note, line));
                }
            }
            else if (line.StartsWith('+'))
            {
                lines.Add(new PatchLine(PatchLineKind.Added, line[1..], null, newNumber++));
            }
            else if (line.StartsWith('-'))
            {
                lines.Add(new PatchLine(PatchLineKind.Removed, line[1..], oldNumber++));
            }
            else if (line.StartsWith('\\'))
            {
                lines.Add(new PatchLine(PatchLineKind.Note, line));
            }
            else if (line.StartsWith(' '))
            {
                lines.Add(new PatchLine(PatchLineKind.Context, line[1..], oldNumber++, newNumber++));
            }
        }

        return lines;
    }

    [GeneratedRegex(@"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")]
    private static partial Regex Hunk();
}
