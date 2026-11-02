using System.Collections.ObjectModel;
using System.Globalization;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One event, as drawn. It carries the page because the row's own context is the event.</summary>
public sealed partial class ActivityRow(ActivityEvent entry, ActivityViewModel page) : ObservableObject
{
    private readonly ActivityLine _line = ActivitySummary.Summarize(entry.Type, entry.Stage, entry.Payload);

    public ActivityViewModel Page => page;

    public string Id => entry.Id;

    public string CardId => entry.CardId;

    public string Label => _line.Label;

    public string Card => entry.CardTitle ?? entry.CardId;

    public string? Reason { get; } = ActivitySummary.Reason(entry.Payload);

    public bool IsGood => _line.Tone == ActivityTone.Good;

    public bool IsBad => _line.Tone == ActivityTone.Bad;

    public bool IsCaution => _line.Tone == ActivityTone.Caution;

    public bool IsGoing => _line.Tone == ActivityTone.Going;

    public string Exactly => entry.CreatedAt.ToLocalTime().ToString("f", CultureInfo.CurrentCulture);

    [ObservableProperty]
    private string _age = string.Empty;

    public void Tick(DateTimeOffset now) => Age = BoardRules.EventAge(entry.CreatedAt, now);
}

/// <summary>What is happening across one project, newest first, kept live from the feed.</summary>
public sealed partial class ActivityViewModel(ShellViewModel shell, string project) : PageViewModel, IFollowsFeed
{
    private const int PageSize = 50;
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan Clock = TimeSpan.FromSeconds(10);

    private readonly WilsonSdk _sdk = shell.Connection!.ForProject(project);
    private CancellationTokenSource? _settling;

    public ObservableCollection<ActivityRow> Events { get; } = [];

    public ShellViewModel Shell => shell;

    public string Project => project;

    [ObservableProperty]
    private bool _live;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanShowOlder))]
    private bool _hasMore;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanShowOlder))]
    private bool _loading;

    [ObservableProperty]
    private bool _empty;

    [ObservableProperty]
    private string? _error;

    public bool CanShowOlder => HasMore && !Loading;

    /// <summary>Reads as many as are showing, so a re-read does not take back what older pages brought in.</summary>
    [RelayCommand]
    public Task RefreshAsync() => ReadAsync(Math.Max(Events.Count, PageSize), CancellationToken.None);

    [RelayCommand]
    public async Task ShowOlderAsync()
    {
        if (Events.Count == 0)
        {
            return;
        }

        Loading = true;
        try
        {
            var older = await _sdk.Board.ListProjectActivityAsync(new ActivityQuery { Limit = PageSize, Before = long.Parse(Events[^1].Id, CultureInfo.InvariantCulture) });
            Add(older);
            HasMore = older.Count == PageSize;
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
        finally
        {
            Loading = false;
        }
    }

    [RelayCommand]
    public void OpenCard(string card) => shell.Push(new CardViewModel(shell, project, card));

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await ReadAsync(Math.Max(Events.Count, PageSize), cancellationToken);
        _ = EveryAsync(Clock, Tick, cancellationToken);
        await shell.Connection!.FollowAsync(
            "/api/feed",
            project,
            signal =>
            {
                Dispatcher.UIThread.Post(() => Follow(signal, cancellationToken));
                return Task.CompletedTask;
            },
            cancellationToken: cancellationToken);
    }

    private void Follow(StreamSignal signal, CancellationToken cancellationToken)
    {
        switch (signal)
        {
            case StreamSignal.Live:
                Live = true;
                break;
            case StreamSignal.Down:
                Live = false;
                break;
            case StreamSignal.Received when !cancellationToken.IsCancellationRequested:
                _settling?.Cancel();
                _settling = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                _ = ReadSettledAsync(_settling.Token);
                break;
            default:
                break;
        }
    }

    private async Task ReadSettledAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(Settle, cancellationToken);
            await ReadAsync(Math.Max(Events.Count, PageSize), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // A later event took over.
        }
    }

    private async Task ReadAsync(int count, CancellationToken cancellationToken)
    {
        try
        {
            var events = await _sdk.Board.ListProjectActivityAsync(new ActivityQuery { Limit = count }, cancellationToken);
            Events.Clear();
            Add(events);
            HasMore = events.Count == count;
            Empty = events.Count == 0;
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Could not load activity: {ApiError.Reason(failure)}";
        }
    }

    private void Add(IEnumerable<ActivityEvent> events)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in events)
        {
            var row = new ActivityRow(entry, this);
            row.Tick(now);
            Events.Add(row);
        }
    }

    private void Tick()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var row in Events)
        {
            row.Tick(now);
        }
    }
}
