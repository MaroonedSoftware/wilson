using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// `StepUpDialog.tsx`, "Confirm it's you". Adding or removing a second factor needs one proved in the last
/// five minutes. Signing in again replaces the session, and the refused request goes again with it.
/// </summary>
public sealed partial class StepUpViewModel(SessionManager session, Action<bool> finish) : ObservableObject
{
    private SignInResult.CodeNeeded? _pending;

    [ObservableProperty]
    private string? _email = session.Email;

    [ObservableProperty]
    private string? _password;

    [ObservableProperty]
    private string? _code;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool _busy;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AsksPassword))]
    private bool _needsCode;

    [ObservableProperty]
    private string? _error;

    public bool AsksPassword => !NeedsCode;

    public bool Idle => !Busy;

    [RelayCommand]
    public void Cancel() => finish(false);

    [RelayCommand]
    public async Task SubmitAsync()
    {
        Busy = true;
        Error = null;
        try
        {
            var result = _pending is { } answering
                ? await session.CompleteSignInAsync(answering, Code?.Trim() ?? string.Empty)
                : await session.SignInAsync(Email?.Trim() ?? string.Empty, Password ?? string.Empty);

            if (result is SignInResult.SignedIn)
            {
                finish(true);
            }
            else if (result is SignInResult.CodeNeeded pending)
            {
                _pending = pending;
                Password = null;
                NeedsCode = true;
            }
            else
            {
                Error = SignInWords.Of(result, NeedsCode);
                Code = null;
            }
        }
        finally
        {
            Busy = false;
        }
    }
}
