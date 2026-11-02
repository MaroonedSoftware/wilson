using Avalonia;
using Avalonia.Styling;
using System.Diagnostics;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>The window's one job: which page is in front, and which server it is talking to.</summary>
public sealed partial class ShellViewModel(ISecretStore store, string settingsPath) : ObservableObject, IDisposable
{
    private static readonly TimeSpan DrainingReading = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan IdleReading = TimeSpan.FromSeconds(60);

    private readonly Stack<PageViewModel> _behind = new();
    private DesktopSettings _settings = HeldDock(DesktopSettings.Load(settingsPath));
    private ThreadsViewModel? _chat;
    private BoardViewModel? _board;
    private ProjectsViewModel? _projects;
    private HostsViewModel? _hosts;
    private SettingsViewModel? _settingsPage;
    private CancellationTokenSource? _watchingDrain;
    private TaskCompletionSource<bool>? _steppingUp;
    private ChatDockViewModel? _dock;
    private bool _dockFollowing;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SignedIn))]
    [NotifyPropertyChangedFor(nameof(OnChat))]
    [NotifyPropertyChangedFor(nameof(OnBoard))]
    [NotifyPropertyChangedFor(nameof(OnProjects))]
    [NotifyPropertyChangedFor(nameof(OnHosts))]
    [NotifyPropertyChangedFor(nameof(OnSettings))]
    [NotifyPropertyChangedFor(nameof(Feed))]
    private PageViewModel? _page;

    [ObservableProperty]
    private bool _canGoBack;

    /// <summary>"n needs human" for the project in hand, or nothing at none, as an always-on "0" is noise.</summary>
    [ObservableProperty]
    private string? _flagged;

    /// <summary>Shown on every page while draining, as a board left draining looks healthy while starting nothing.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DrainBadge))]
    [NotifyPropertyChangedFor(nameof(DrainLine))]
    private DrainStatus? _drain;

    /// <summary>"Confirm it's you", over whatever page asked. Never open without something waiting on it.</summary>
    [ObservableProperty]
    private StepUpViewModel? _stepUp;

    /// <summary>Absent where nothing checks for updates, such as in tools/Walk.</summary>
    public UpdateViewModel? Updates { get; init; }

    public ServerConnection? Connection { get; private set; }

    public DesktopSettings Settings => _settings;

    /// <summary>Everything but the sign-in page sits under the header.</summary>
    public Appearance Appearance => _settings.Appearance;

    public bool SignedIn => Page is not (null or SignInViewModel);

    /// <summary>On every page but chat itself, as the web app's header has it.</summary>
    public bool CanDock => SignedIn && Page is not ThreadsViewModel;

    public bool DockOpen => _settings.Dock.Open;

    public ChatDockViewModel? RightDock => CanDock && DockOpen && _settings.Dock.Position == ChatDockPosition.Right ? _dock : null;

    public ChatDockViewModel? BottomDock => CanDock && DockOpen && _settings.Dock.Position == ChatDockPosition.Bottom ? _dock : null;

    public ChatDock Dock => _settings.Dock;

    public bool OnChat => Section is ThreadsViewModel;

    public bool OnBoard => Section is BoardViewModel;

    public bool OnProjects => Section is ProjectsViewModel;

    public bool OnHosts => Section is HostsViewModel;

    public bool OnSettings => Section is SettingsViewModel;

    public string? DrainBadge => Drain is { } status ? SettingsRules.DrainBadge(status) : null;

    public string? DrainLine => Drain is { } status ? SettingsRules.DrainLine(status) : null;

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
        Connection.Session.StepUp = AskStepUpAsync;
        Remember(_settings.Origin == origin ? _settings : _settings with { Origin = origin, Project = null, Thread = null, Collapsed = new Dictionary<string, IReadOnlyList<string>>() });
        return Connection;
    }

    /// <summary>Kept, so an open chat and the chosen project survive a trip between sections.</summary>
    [RelayCommand]
    public void ShowChat() => Go(_chat ??= new ThreadsViewModel(this));

    [RelayCommand]
    public void ShowBoard() => Go(_board ??= new BoardViewModel(this));

    /// <summary>What is happening across the project in front. Back returns to the page it was opened from.</summary>
    [RelayCommand]
    public void ShowActivity()
    {
        if (Feed?.Project is { } project && Page is not ActivityViewModel)
        {
            Push(new ActivityViewModel(this, project));
        }
    }

    /// <summary>The cards needing a human: the board narrowed to them, as the web app's flagged page is.</summary>
    [RelayCommand]
    public void ShowFlagged()
    {
        ShowBoard();
        _board!.FlaggedOnly = true;
    }

    /// <summary>The board's own count, which is the freshest there is.</summary>
    public void ReportFlagged(int count) => Flagged = count > 0 ? $"{count} needs human" : null;

    [RelayCommand]
    public void ShowProjects() => Go(_projects ??= new ProjectsViewModel(this));

    [RelayCommand]
    public void ShowHosts() => Go(_hosts ??= new HostsViewModel(this));

    [RelayCommand]
    public void ShowSettings() => Go(_settingsPage ??= new SettingsViewModel(this));

    /// <summary>A project just made: the board learns of it and shows it.</summary>
    public async Task ProjectAddedAsync(string project)
    {
        if (_board is { } board)
        {
            await board.ReadProjectsAsync();
        }

        ShowProject(project);
    }

    /// <summary>A project's board, chosen from the projects page.</summary>
    public void ShowProject(string project)
    {
        ArgumentException.ThrowIfNullOrEmpty(project);

        RememberProject(project);
        _board?.Choose(project);
        ShowBoard();
    }

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

    /// <summary>A card cited in text: in the project being read, or for chat, which has none, the last one shown.</summary>
    public async Task OpenReferenceAsync(string id)
    {
        var project = (Page as CardViewModel)?.Project ?? _board?.Project ?? _settings.Project;
        try
        {
            project ??= (await Connection!.Sdk.Projects.ListProjectsAsync()).FirstOrDefault()?.Name;
        }
        catch (HttpRequestException failure)
        {
            Trace.WriteLine($"reference: {failure.Message}");
        }

        if (project is not null)
        {
            Push(new CardViewModel(this, project, id));
        }
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

    /// <summary>Ctrl or Cmd+J, which does nothing on chat, where the dock has no place.</summary>
    [RelayCommand]
    public void ToggleDock()
    {
        if (CanDock)
        {
            Remember(_settings with { Dock = _settings.Dock with { Open = !_settings.Dock.Open } });
            SyncDock();
        }
    }

    public void MoveDock(ChatDockPosition position)
    {
        Remember(_settings with { Dock = _settings.Dock with { Position = position } });
        SyncDock();
    }

    /// <summary>During a drag, so nothing is written until it ends.</summary>
    public void ResizeDock(int? width = null, int? height = null)
    {
        var dock = _settings.Dock;
        _settings = _settings with { Dock = (dock with { Width = width ?? dock.Width, Height = height ?? dock.Height }).Held() };
        OnPropertyChanged(nameof(Dock));
    }

    public void KeepDockSize() => Remember(_settings);

    [RelayCommand]
    public void NextAppearance()
    {
        Remember(_settings with { Appearance = Appearances.Next(_settings.Appearance) });
        OnPropertyChanged(nameof(Appearance));
        Draw();
    }

    public void RememberProject(string project) => Remember(_settings with { Project = project });

    public void RememberCollapsed(string project, IReadOnlyList<string> stages) =>
        Remember(_settings with { Collapsed = new Dictionary<string, IReadOnlyList<string>>(_settings.Collapsed) { [project] = stages } });

    public void RememberThread(string? thread) => Remember(_settings with { Thread = thread });

    public void Dispose()
    {
        StopWatchingDrain();
        Page?.Hidden();
        Connection?.Dispose();
    }

    /// <summary>
    /// The dock shows the chat page's own model: one conversation, wherever it is drawn. The page follows
    /// its stream only while shown, so with the dock open the shell shows it, and hides it again unless it
    /// has since come to the front itself.
    /// </summary>
    private void SyncDock()
    {
        if (CanDock && DockOpen)
        {
            _chat ??= new ThreadsViewModel(this);
            _dock ??= new ChatDockViewModel(this, _chat);
            if (!_dockFollowing)
            {
                _dockFollowing = true;
                _chat.Shown();
            }
        }
        else if (_dockFollowing)
        {
            _dockFollowing = false;
            if (Page != _chat)
            {
                _chat?.Hidden();
            }
        }

        OnPropertyChanged(nameof(CanDock));
        OnPropertyChanged(nameof(DockOpen));
        OnPropertyChanged(nameof(RightDock));
        OnPropertyChanged(nameof(BottomDock));
        OnPropertyChanged(nameof(Dock));
    }

    /// <summary>Requests refused together share one question, as one new session answers them all.</summary>
    private Task<bool> AskStepUpAsync(CancellationToken cancellationToken) => Dispatcher.UIThread.InvokeAsync(() =>
    {
        if (_steppingUp is null)
        {
            _steppingUp = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            StepUp = new StepUpViewModel(Connection!.Session, FinishStepUp);
        }

        return _steppingUp.Task.WaitAsync(cancellationToken);
    });

    private void FinishStepUp(bool confirmed)
    {
        StepUp = null;
        _steppingUp?.TrySetResult(confirmed);
        _steppingUp = null;
    }

    /// <summary>Often while draining, as that is when someone is waiting for it to be safe. A key that may not read it simply shows nothing.</summary>
    private async Task WatchDrainAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                try
                {
                    Drain = await Connection!.Sdk.Settings.GetDrainStatusAsync(cancellationToken);
                }
                catch (HttpRequestException failure)
                {
                    Trace.WriteLine($"drain: {failure.Message}");
                    Drain = null;
                }

                await Task.Delay(Drain?.Draining == true ? DrainingReading : IdleReading, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Signing out is how the watch ends.
        }
    }

    private void StopWatchingDrain()
    {
        _watchingDrain?.Cancel();
        _watchingDrain?.Dispose();
        _watchingDrain = null;
        Drain = null;
    }

    /// <summary>Away from the board nothing is following the feed, so the header's count is read on each change of page.</summary>
    private async Task ReadFlaggedAsync()
    {
        try
        {
            var project = _board?.Project ?? _settings.Project ?? (await Connection!.Sdk.Projects.ListProjectsAsync()).FirstOrDefault()?.Name;
            if (project is not null && Connection is { } connection)
            {
                using var sdk = connection.ForProject(project);
                ReportFlagged((await sdk.Board.ListCardsAsync()).Count(card => card.NeedsHuman));
            }
        }
        catch (HttpRequestException failure)
        {
            Trace.WriteLine($"flagged: {failure.Message}");
        }
    }

    private void ShowSignIn()
    {
        Flagged = null;
        FinishStepUp(false);
        StopWatchingDrain();
        _dockFollowing = false;
        _dock?.Dispose();
        _dock = null;
        _chat?.Dispose();
        _board?.Dispose();
        _projects?.Dispose();
        _hosts?.Dispose();
        _settingsPage?.Dispose();
        _chat = null;
        _board = null;
        _projects = null;
        _hosts = null;
        _settingsPage = null;
        Replace(new SignInViewModel(this));
    }

    private static DesktopSettings HeldDock(DesktopSettings settings) => settings with { Dock = settings.Dock.Held() };

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
        if (SignedIn && _watchingDrain is null)
        {
            _watchingDrain = new CancellationTokenSource();
            _ = WatchDrainAsync(_watchingDrain.Token);
        }

        SyncDock();
        if (SignedIn && page is not BoardViewModel)
        {
            _ = ReadFlaggedAsync();
        }
    }

    private void Remember(DesktopSettings settings)
    {
        _settings = settings;
        _settings.Save(settingsPath);
    }
}
