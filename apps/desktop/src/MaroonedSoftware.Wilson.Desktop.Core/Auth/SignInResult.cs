namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>What a sign-in step came to. Each case is a different thing for the person to do next.</summary>
public abstract record SignInResult
{
    private SignInResult()
    {
    }

    public sealed record SignedIn : SignInResult;

    /// <summary>The password was right and an authenticator code is next.</summary>
    public sealed record CodeNeeded(string ChallengeId, string FactorId, string? Label) : SignInResult;

    /// <summary>The account's only second factor is a passkey, which works only in the web app.</summary>
    public sealed record PasskeyOnly : SignInResult;

    /// <summary>Wrong email, password or code. The API deliberately does not say which.</summary>
    public sealed record Refused : SignInResult;

    public sealed record TooManyAttempts : SignInResult;

    /// <summary>The server could not be asked, or answered with something else.</summary>
    public sealed record Unavailable(string? Message) : SignInResult;
}

/// <summary>
/// A refresh has three outcomes, because "the session is over" and "the server could not be asked"
/// want opposite handling: one signs the operator out, the other changes nothing.
/// </summary>
public abstract record RefreshOutcome
{
    private RefreshOutcome()
    {
    }

    public sealed record Renewed(string AccessToken) : RefreshOutcome;

    public sealed record SessionEnded : RefreshOutcome;

    public sealed record Unavailable : RefreshOutcome;
}
