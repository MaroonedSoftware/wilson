using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>Finding a server and then signing in to it, a step at a time, as deadair's setup screen does.</summary>
/// <remarks>
/// The address is probed before it is kept, so a mistyped one is found here rather than as a refused
/// password. Deadair's station names itself and waits for a press; a server has no name to confirm, so
/// an address that answers moves straight on, as in the Android app.
/// </remarks>
public sealed partial class SignInViewModel(ShellViewModel shell) : PageViewModel
{
    private SignInResult.CodeNeeded? _pending;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Welcoming))]
    [NotifyPropertyChangedFor(nameof(Finding))]
    [NotifyPropertyChangedFor(nameof(SigningIn))]
    [NotifyPropertyChangedFor(nameof(NeedsCode))]
    [NotifyPropertyChangedFor(nameof(ShowsPasswordStep))]
    [NotifyPropertyChangedFor(nameof(CanGoBack))]
    [NotifyPropertyChangedFor(nameof(SigningInTo))]
    [NotifyCanExecuteChangedFor(nameof(BackCommand))]
    private SignInStep _step = SignInSteps.Initial(shell.Settings.Origin);

    [ObservableProperty]
    private string? _address = shell.Settings.Origin;

    [ObservableProperty]
    private string? _email;

    [ObservableProperty]
    private string? _password;

    [ObservableProperty]
    private string? _code;

    [ObservableProperty]
    private bool _busy;

    [ObservableProperty]
    private string? _error;

    public bool Welcoming => Step == SignInStep.Welcome;

    public bool Finding => Step == SignInStep.Server;

    /// <summary>The password and the code share a heading, because the code continues the same sign-in.</summary>
    public bool SigningIn => Step is SignInStep.Password or SignInStep.Code;

    public bool ShowsPasswordStep => Step == SignInStep.Password;

    public bool NeedsCode => Step == SignInStep.Code;

    public bool CanGoBack => Step != SignInStep.Welcome;

    /// <summary>The server being signed in to, for the heading.</summary>
    public string SigningInTo => shell.Settings.Origin is { } origin ? new Uri(origin).Authority : string.Empty;

    [RelayCommand]
    public void Start() => Step = SignInStep.Server;

    [RelayCommand(CanExecute = nameof(CanGoBack))]
    public void Back()
    {
        Error = null;
        _pending = null;
        Code = null;
        Step = SignInSteps.Back(Step, shell.Settings.Origin);
    }

    [RelayCommand]
    public async Task CheckAsync()
    {
        Error = null;
        if (ServerAddress.Parse(Address) is not { } origin)
        {
            Error = "That does not look like an address. Try something like wilson.example.com.";
            return;
        }

        Busy = true;
        try
        {
            var result = await ServerProbe.AskAsync(origin);
            if (result == ServerProbeResult.Wilson)
            {
                shell.Connect(origin);
                Address = origin;
                Step = SignInStep.Password;
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

    [RelayCommand]
    public async Task SubmitAsync()
    {
        Busy = true;
        Error = null;
        try
        {
            var session = shell.Connection!.Session;
            var result = _pending is { } answering
                ? await session.CompleteSignInAsync(answering, Code?.Trim() ?? string.Empty)
                : await session.SignInAsync(Email?.Trim() ?? string.Empty, Password ?? string.Empty);

            if (result is SignInResult.SignedIn)
            {
                Password = null;
                shell.ShowBoard();
            }
            else if (result is SignInResult.CodeNeeded pending)
            {
                _pending = pending;
                Password = null;
                Code = null;
                Step = SignInStep.Code;
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

    private static string Words(ServerProbeResult result) => result switch
    {
        ServerProbeResult.NotWilson => "Something answered at that address, but it is not a Wilson server.",
        ServerProbeResult.Untrusted => "This Mac does not trust that server's certificate. Add its certificate authority to the system keychain, mark it trusted, and try again.",
        _ => "Nothing answered at that address. Check the server is running.",
    };

    private string? Words(SignInResult result) => result switch
    {
        SignInResult.Refused => NeedsCode ? "That code was not accepted. Check your authenticator and try the next one." : "Wrong email or password.",
        SignInResult.TooManyAttempts => "Too many wrong attempts. Wait five minutes and try again.",
        SignInResult.PasskeyOnly => "This account's second factor is a passkey, which works only in the web app. Add an authenticator there to sign in here.",
        SignInResult.Unavailable unavailable => unavailable.Message ?? "Could not reach the server.",
        _ => null,
    };
}
