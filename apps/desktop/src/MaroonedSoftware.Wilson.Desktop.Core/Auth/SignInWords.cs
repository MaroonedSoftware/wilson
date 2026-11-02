using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>Why a sign-in stopped, in the operator's words. A wrong password, a wrong code and a lockout are told apart.</summary>
public static class SignInWords
{
    public static string? Of(SignInResult result, bool answeringCode) => result switch
    {
        SignInResult.Refused => answeringCode ? "That code was not accepted. Check your authenticator and try the next one." : "Wrong email or password.",
        SignInResult.TooManyAttempts => "Too many wrong attempts. Wait five minutes and try again.",
        SignInResult.PasskeyOnly => "This account's second factor is a passkey, which works only in the web app. Add an authenticator there to sign in here.",
        SignInResult.Unavailable unavailable => unavailable.Message ?? "Could not reach the server.",
        _ => null,
    };

    /// <summary>Why making the account failed, by the same rules as `onboardingFailure` in `lib/auth.ts`.</summary>
    public static string OfAccount(Exception failure) => failure switch
    {
        SdkException { Status: 409 } => "An account already exists. Go back and sign in.",
        SdkException refused when ApiError.PasswordAdvice(refused) is { } advice => $"That password is too easy to guess. {advice}".TrimEnd(),
        _ => ApiError.Reason(failure),
    };

    /// <summary>A code refused while setting up an authenticator, by the same rules as `codeFailure` in `lib/auth.ts`.</summary>
    public static string OfCode(Exception failure) => failure switch
    {
        SdkException { Status: 401 } => "That code is wrong or has already been used. Try the next one.",
        SdkException { Status: 429 } => "Too many wrong codes. Wait five minutes and try again.",
        _ => ApiError.Reason(failure),
    };
}
