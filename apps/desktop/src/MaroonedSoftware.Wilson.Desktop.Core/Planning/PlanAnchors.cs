namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>A quote and the text around it as it read when captured. Never an offset: the agent rewrites the whole draft every turn.</summary>
public sealed record PlanAnchor(string Quote, string Prefix, string Suffix);

/// <summary>Where a quote sits now. An output of `Locate`, and never stored.</summary>
public readonly record struct AnchorRange(int Start, int End);

/// <summary>
/// Finding a quoted passage again after a rewrite, by the web app's `lib/anchor.ts`, against the same
/// text it uses, the draft as read rather than its Markdown (`ChatMarkdown.RenderedText`), so a comment
/// made in either client stays attached in the other.
/// </summary>
public static class PlanAnchors
{
    private const int Window = 60;

    public static PlanAnchor Capture(string text, int start, int end)
    {
        ArgumentNullException.ThrowIfNull(text);

        return new PlanAnchor(text[start..end], text[Math.Max(0, start - Window)..start], text[end..Math.Min(text.Length, end + Window)]);
    }

    /// <summary>
    /// A unique quote is found whatever surrounds it now. A repeated one goes to the occurrence whose
    /// surroundings survive best, and a tie is nothing: reattaching to the wrong passage is what this
    /// exists to avoid, so that comment is outdated instead.
    /// </summary>
    public static AnchorRange? Locate(string text, PlanAnchor anchor)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(anchor);

        var starts = Occurrences(text, anchor.Quote);
        if (starts.Count == 0)
        {
            return null;
        }

        if (starts.Count == 1)
        {
            return new AnchorRange(starts[0], starts[0] + anchor.Quote.Length);
        }

        var scored = starts.Select(start =>
        {
            var end = start + anchor.Quote.Length;
            var before = text[Math.Max(0, start - anchor.Prefix.Length)..start];
            var after = text[end..Math.Min(text.Length, end + anchor.Suffix.Length)];
            return (Start: start, Score: Trailing(before, anchor.Prefix) + Leading(after, anchor.Suffix));
        }).ToList();
        var best = scored.Max(item => item.Score);
        var winners = scored.Where(item => item.Score == best).ToList();
        return winners.Count == 1 ? new AnchorRange(winners[0].Start, winners[0].Start + anchor.Quote.Length) : null;
    }

    private static List<int> Occurrences(string text, string quote)
    {
        var starts = new List<int>();
        if (quote.Length == 0)
        {
            return starts;
        }

        for (var at = text.IndexOf(quote, StringComparison.Ordinal); at >= 0; at = text.IndexOf(quote, at + 1, StringComparison.Ordinal))
        {
            starts.Add(at);
        }

        return starts;
    }

    private static int Trailing(string actual, string expected)
    {
        var limit = Math.Min(actual.Length, expected.Length);
        var count = 0;
        while (count < limit && actual[actual.Length - 1 - count] == expected[expected.Length - 1 - count])
        {
            count++;
        }

        return count;
    }

    private static int Leading(string actual, string expected)
    {
        var limit = Math.Min(actual.Length, expected.Length);
        var count = 0;
        while (count < limit && actual[count] == expected[count])
        {
            count++;
        }

        return count;
    }
}
