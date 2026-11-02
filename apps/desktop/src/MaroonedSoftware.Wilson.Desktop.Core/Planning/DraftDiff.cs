namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>One changed line of a draft.</summary>
public sealed record DraftDiffLine(bool Added, string Text);

/// <summary>What a save would change, by the web app's `lib/diff.ts`: line by line, with no context lines.</summary>
public static class DraftDiff
{
    public static IReadOnlyList<DraftDiffLine> Lines(string before, string after)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);

        var a = before.Split('\n');
        var b = after.Split('\n');
        var common = new int[a.Length + 1, b.Length + 1];
        for (var i = a.Length - 1; i >= 0; i--)
        {
            for (var j = b.Length - 1; j >= 0; j--)
            {
                common[i, j] = a[i] == b[j] ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
            }
        }

        var lines = new List<DraftDiffLine>();
        var (x, y) = (0, 0);
        while (x < a.Length && y < b.Length)
        {
            if (a[x] == b[y])
            {
                x++;
                y++;
            }
            else if (common[x + 1, y] >= common[x, y + 1])
            {
                lines.Add(new DraftDiffLine(false, a[x++]));
            }
            else
            {
                lines.Add(new DraftDiffLine(true, b[y++]));
            }
        }

        lines.AddRange(a[x..].Select(line => new DraftDiffLine(false, line)));
        lines.AddRange(b[y..].Select(line => new DraftDiffLine(true, line)));
        return lines;
    }
}
