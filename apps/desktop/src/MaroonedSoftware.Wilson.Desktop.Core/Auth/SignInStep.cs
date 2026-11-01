namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>Which part of the sign-in screen is showing. Deadair's setup steps, with the Android app's code step.</summary>
public enum SignInStep
{
    Welcome,
    Server,

    /// <summary>Never reached without a server: an account belongs to one, and there is none until an address has answered.</summary>
    Password,
    Code,
}

/// <summary>How the sign-in screen moves.</summary>
public static class SignInSteps
{
    /// <summary>The welcome on a first run, and the password when a server is remembered.</summary>
    public static SignInStep Initial(string? keptOrigin) => keptOrigin is null ? SignInStep.Welcome : SignInStep.Password;

    /// <summary>
    /// One step back. From the address, that is the password when a server is remembered: a welcome in
    /// front of somebody who only went to change the address would be a step that leads nowhere new.
    /// </summary>
    public static SignInStep Back(SignInStep step, string? keptOrigin) => step switch
    {
        SignInStep.Code => SignInStep.Password,
        SignInStep.Password => SignInStep.Server,
        SignInStep.Server => Initial(keptOrigin),
        _ => step,
    };
}
