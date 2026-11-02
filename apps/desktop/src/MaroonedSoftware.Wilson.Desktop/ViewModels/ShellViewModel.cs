using Avalonia;
using Avalonia.Styling;
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
    private ThreadsViewModel? _chat;
    private BoardViewModel? _board;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SignedIn))]
    [NotifyPropertyChangedFor(nameof(OnChat))]
    [NotifyPropertyChangedFor(nameof(OnBoard))]
    [NotifyPropertyChangedFor(nameof(Feed))]
    private PageViewModel? _page;

    [ObservableProperty]
    private bool _canGoBack;

    /// <summary>Absent where nothing checks for updates, such as in tools/Walk.</summary>
    public UpdateViewModel? Updates { get; init; }

    public ServerConnection? Connection { get; private set; }

    public DesktopSettings Settings => _settings;

    /// <summary>Everything but the sign-in page sits under the header.</summary>
    public Appearance Appearance => _settings.Appearance;

    public bool SignedIn => Page is not (null or SignInViewModel);

    public bool OnChat => Section is ThreadsViewModel;

    public bool OnBoard => Section is BoardViewModel;

    public IFollowsFeed? Feed => Page as IFollowsFeed;

    /// <summary>What the header marks: a card is still on the board.</summary>
    private PageViewModel? Section => _behind.LastOrDefault() ?? Page;

    /// <summary>Goes to chat if a session was kept for the remembered server, and to sign-in otherwise.</summary>
    public async Task StartAsync()
    {
        Draw();
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
        Remember(_settings.Origin == origin ? _settings : _settings with { Origin = origin, Project = null, Thread = null });
        return Connection;
    }

    /// <summary>Kept, so an open chat and the chosen project survive a trip between sections.</summary>
    [RelayCommand]
    public void ShowChat() => Go(_chat ??= new ThreadsViewModel(this));

    [RelayCommand]
    public void ShowBoard() => Go(_board ??= new BoardViewModel(this));

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

    [RelayCommand]
    public void NextAppearance()
    {
        Remember(_settings with { Appearance = Appearances.Next(_settings.Appearance) });
        OnPropertyChanged(nameof(Appearance));
        Draw();
    }

    public void RememberProject(string project) => Remember(_settings with { Project = project });

    public void RememberThread(string? thread) => Remember(_settings with { Thread = thread });

    public void Dispose()
    {
        Page?.Hidden();
        Connection?.Dispose();
    }

    private void ShowSignIn()
    {
        _chat?.Dispose();
        _board?.Dispose();
        _chat = null;
        _board = null;
        Replace(new SignInViewModel(this));
    }

    private void Draw()
    {
        if (Application.Current is { } app)
        {
            app.RequestedThemeVariant = _settings.Appearance switch
            {
                Appearance.Light => ThemeVariant.Light,
                Appearance.Dark => ThemeVariant.Dark,
                _ => ThemeVariant.Default,
            };
        }
    }

    private void Go(PageViewModel section)
    {
        if (Page != section)
        {
            Replace(section);
        }
    }

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
