using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>The server's address and the sign-in, on one screen because a first run needs both.</summary>
public sealed partial class SignInViewModel(ShellViewModel shell) : PageViewModel
{
    private SignInResult.CodeNeeded? _pending;

    [ObservableProperty]
    private string? _address = shell.Settings.Origin;

    [ObservableProperty]
    private string? _email;

    [ObservableProperty]
    private string? _password;

    [ObservableProperty]
    private string? _code;

    [ObservableProperty]
    private bool _needsCode;

    [ObservableProperty]
    private bool _busy;

    [ObservableProperty]
    private string? _error;

    [RelayCommand]
    public async Task SubmitAsync()
    {
        Busy = true;
        Error = null;
        try
        {
            var result = await SignInAsync();
            if (result is SignInResult.SignedIn)
            {
                shell.ShowBoard();
            }
            else if (result is SignInResult.CodeNeeded pending)
            {
                _pending = pending;
                NeedsCode = true;
            }
            else
            {
                Error = Words(result);
            }
        }
        finally
        {
            Busy = false;
        }
    }

    protected override Task OnShownAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task<SignInResult?> SignInAsync()
    {
        if (ServerAddress.Parse(Address) is not { } origin)
        {
            Error = "That address does not look right.";
            return null;
        }

        var session = shell.Connect(origin).Session;
        return _pending is { } pending
            ? await session.CompleteSignInAsync(pending, Code?.Trim() ?? string.Empty)
            : await session.SignInAsync(Email?.Trim() ?? string.Empty, Password ?? string.Empty);
    }

    private string? Words(SignInResult? result) => result switch
    {
        null => Error,
        SignInResult.Refused => NeedsCode ? "That code was not accepted." : "Wrong email or password.",
        SignInResult.TooManyAttempts => "Too many wrong attempts. Wait five minutes and try again.",
        SignInResult.PasskeyOnly => "This account's second factor is a passkey, which works only in the web app. Add an authenticator there to sign in here.",
        SignInResult.Unavailable unavailable => unavailable.Message ?? "Could not reach the server.",
        _ => null,
    };
}
