using System.Text.RegularExpressions;

namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>
/// What `claude setup-token` prints for people to read, which is no interface and can change with any
/// release (`CLAUDE.md`). Finding nothing is an answer: the person pastes the token instead.
/// </summary>
public static partial class SetupTokenOutput
{
    /// <summary>Shorter than this is a token cut off by something, which would save and then fail every engine.</summary>
    private const int ShortestToken = 40;

    /// <summary>The token printed, or null when there is not exactly one complete one.</summary>
    public static string? Token(string output)
    {
        var tokens = TokenPattern().Matches(Readable(output)).Select(match => match.Value).Distinct().ToList();
        return tokens is [{ Length: >= ShortestToken } token] ? token : null;
    }

    /// <summary>The link the browser was sent to, so it can be opened in another one.</summary>
    public static string? SignInLink(string output) => LinkPattern().Match(Readable(output)) is { Success: true } match ? match.Value : null;

    /// <summary>The text without its escapes. A move right stands for spaces, and the rest draw nothing.</summary>
    private static string Readable(string output) => EscapePattern().Replace(MoveRightPattern().Replace(output, " "), string.Empty);

    [GeneratedRegex(@"\x1b\[[0-9]*C")]
    private static partial Regex MoveRightPattern();

    [GeneratedRegex(@"\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[0-9A-Za-z()][0-9A-Z]?")]
    private static partial Regex EscapePattern();

    [GeneratedRegex(@"sk-ant-[a-z0-9]+-[A-Za-z0-9_-]+")]
    private static partial Regex TokenPattern();

    [GeneratedRegex(@"https://[^\s/]+/\S*oauth/authorize\?\S+")]
    private static partial Regex LinkPattern();
}
