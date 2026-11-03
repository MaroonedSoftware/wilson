namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>Why signing in gave no token. Each has its own advice, and none carries what the command printed.</summary>
public enum ClaudeSignInFailure
{
    NotFound,
    NoToken,
    TimedOut,
}

/// <summary>
/// A token, or why there is none. A class and not a record, whose generated `ToString` would print the
/// token into whatever logged it.
/// </summary>
public sealed class ClaudeSignInResult
{
    private ClaudeSignInResult(string? token, ClaudeSignInFailure? failure)
    {
        Token = token;
        Failure = failure;
    }

    public string? Token { get; }

    public ClaudeSignInFailure? Failure { get; }

    public static ClaudeSignInResult Succeeded(string token) => new(token, null);

    public static ClaudeSignInResult Failed(ClaudeSignInFailure failure) => new(null, failure);

    /// <summary>What the person should do next.</summary>
    public string? Advice => Failure switch
    {
        ClaudeSignInFailure.NotFound => "Couldn't find Claude Code on this Mac. Install it, or run claude setup-token where it is installed and paste the token.",
        ClaudeSignInFailure.NoToken => "That sign-in gave no token Wilson could read. Try again, or run claude setup-token in a terminal and paste the token.",
        ClaudeSignInFailure.TimedOut => "The sign-in wasn't finished in time. Try again, or run claude setup-token in a terminal and paste the token.",
        _ => null,
    };
}

/// <summary>Signing in to Claude to make a token, which only a machine with `claude` on it can do.</summary>
public interface IClaudeSignIn
{
    /// <summary>
    /// Run the sign-in until it gives a token or fails. <paramref name="link"/> hears the browser's link
    /// once it is known. Cancelling throws <see cref="OperationCanceledException"/>.
    /// </summary>
    Task<ClaudeSignInResult> RunAsync(IProgress<string> link, CancellationToken cancellationToken = default);
}
