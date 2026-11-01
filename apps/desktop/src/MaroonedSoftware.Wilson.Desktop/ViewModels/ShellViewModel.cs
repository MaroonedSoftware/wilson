using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>The window's one job: which page is in front, and which server it is talking to.</summary>
public sealed partial class ShellViewModel(ISecretStore store, string settingsPath) : ObservableObject, IDisposable
{
    private readonly Stack<PageViewModel> _behind = new();
    private DesktopSettings _settings = DesktopSettings.Load(settingsPath);

    [ObservableProperty]
    private PageViewModel? _page;

    [ObservableProperty]
    private bool _canGoBack;

    /// <summary>Absent where nothing checks for updates, such as in tools/Walk.</summary>
    public UpdateViewModel? Updates { get; init; }

    public ServerConnection? Connection { get; private set; }

    public DesktopSettings Settings => _settings;

    /// <summary>Goes to chat if a session was kept for the remembered server, and to sign-in otherwise.</summary>
    public async Task StartAsync()
    {
        if (_settings.Origin is { } origin)
        {
            var connection = Connect(origin);
            await connection.Session.RestoreAsync();
            if (connection.Session.IsSignedIn)
            {
                ShowChat();
                return;
            }
        }

        ShowSignIn();
    }

    /// <summary>Points the app at a server, letting go of any other.</summary>
    public ServerConnection Connect(string origin)
    {
        if (Connection?.Origin == origin)
        {
            return Connection;
        }

        Connection?.Dispose();
        Connection = new ServerConnection(origin, store);
        Connection.Session.SessionEnded += (_, _) => Dispatcher.UIThread.Post(ShowSignIn);
        Remember(_settings with { Origin = origin, Project = _settings.Origin == origin ? _settings.Project : null });
        return Connection;
    }

    public void ShowChat() => Replace(new ThreadsViewModel(this));

    public void Push(PageViewModel page)
    {
        ArgumentNullException.ThrowIfNull(page);

        if (Page is { } current)
        {
            current.Hidden();
            _behind.Push(current);
        }

        Front(page);
    }

    [RelayCommand]
    public void Back()
    {
        if (_behind.TryPop(out var previous))
        {
            Page?.Hidden();
            Front(previous);
        }
    }

    [RelayCommand]
    public async Task SignOutAsync()
    {
        if (Connection is { } connection)
        {
            await connection.Session.SignOutAsync();
        }

        ShowSignIn();
    }

    public void RememberProject(string project) => Remember(_settings with { Project = project });

    public void Dispose()
    {
        Page?.Hidden();
        Connection?.Dispose();
    }

    private void ShowSignIn() => Replace(new SignInViewModel(this));

    private void Replace(PageViewModel page)
    {
        Page?.Hidden();
        _behind.Clear();
        Front(page);
    }

    private void Front(PageViewModel page)
    {
        Page = page;
        CanGoBack = _behind.Count > 0;
        page.Shown();
    }

    private void Remember(DesktopSettings settings)
    {
        _settings = settings;
        _settings.Save(settingsPath);
    }
}
