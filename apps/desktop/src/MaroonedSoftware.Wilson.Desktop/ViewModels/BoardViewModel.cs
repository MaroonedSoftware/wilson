using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A card on the board, with what the rest of the board says about it. A clock and the feed change it in place, as redrawing a column would lose its scroll.</summary>
public sealed partial class BoardTile(CardSummary card, string? flag, string? blocked, string? deps, string? pieces) : ObservableObject
{
    public CardSummary Card => card;

    public CardFace? Face { get; } = BoardRules.Face(card);

    public string? Flag => flag;

    public string? Blocked => blocked;

    public string? Deps => deps;

    public string? Pieces => pieces;

    [ObservableProperty]
    private string? _inStage;

    [ObservableProperty]
    private string? _lastEvent;

    [ObservableProperty]
    private bool _stale;

    /// <summary>Held by the pointer, so the card under it reads as still where it was.</summary>
    [ObservableProperty]
    private bool _dragged;

    /// <summary>A move in flight: the card stays in its column until a re-read agrees it went.</summary>
    [ObservableProperty]
    private bool _pending;

    /// <summary>Reads the ages again. A line is absent rather than guessed.</summary>
    public void Tick(CardActivity? activity, DateTimeOffset now)
    {
        InStage = card.StageEnteredAt is { } entered ? BoardRules.AgeInStage(entered, now) : null;
        var shows = BoardRules.ShowsLastEvent(activity, card.Stage);
        LastEvent = shows ? $"last event {BoardRules.EventAge(activity!.Ts, now)}" : null;
        Stale = shows && now - activity!.Ts >= BoardRules.LastEventStaleAfter;
    }
}

/// <summary>One column of the board, as drawn.</summary>
public sealed partial class BoardColumn(string name, IReadOnlyList<BoardTile> cards) : ObservableObject
{
    public string Name => name;

    public IReadOnlyList<BoardTile> Cards => cards;

    public string Count { get; } = cards.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>"n flagged", or nothing when none are.</summary>
    public string? Flagged { get; } = cards.Count(tile => tile.Card.NeedsHuman) is var flagged and > 0 ? $"{flagged} flagged" : null;

    /// <summary>Folded to a rail. It is still somewhere to drop a card.</summary>
    [ObservableProperty]
    private bool _collapsed;

    /// <summary>Where a card held over it would go.</summary>
    [ObservableProperty]
    private bool _target;
}

/// <summary>A project's cards, kept live from the feed for as long as the board is in front.</summary>
public sealed partial class BoardViewModel(ShellViewModel shell) : PageViewModel, IFollowsFeed
{
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan Clock = TimeSpan.FromSeconds(10);

    private readonly CardFeedLog _log = new();
    private List<CardSummary> _cards = [];
    private List<CardSummary> _shown = [];
    private IReadOnlyList<string> _order = [];
    private CancellationTokenSource? _settling;
    private bool _choosing;
    private bool _held;
    private bool _drawOwed;
    private bool _unread;
    private string? _moving;

    public ObservableCollection<string> Projects { get; } = [];

    public ObservableCollection<BoardColumn> Columns { get; } = [];

    [ObservableProperty]
    private string? _project;

    [ObservableProperty]
    private bool _flaggedOnly;

    [ObservableProperty]
    private string? _filter;

    [ObservableProperty]
    private string? _count;

    [ObservableProperty]
    private bool _live;

    [ObservableProperty]
    private string? _error;

    public string Server => shell.Connection?.Origin ?? string.Empty;

    [RelayCommand]
    public void OpenCard(CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        if (Project is { } project)
        {
            shell.Push(new CardViewModel(shell, project, card.Id));
        }
    }

    [RelayCommand]
    public void NewCard()
    {
        if (Project is { } project)
        {
            shell.Push(new CardFormViewModel(shell, project, null));
        }
    }

    [RelayCommand]
    public Task RefreshAsync() => LoadAsync(CancellationToken.None);

    /// <summary>Another project, while the board is not in front. Showing it reads that project.</summary>
    public void Choose(string project)
    {
        if (Projects.Contains(project) && project != Project)
        {
            _choosing = true;
            Project = project;
            _choosing = false;
            Columns.Clear();
            Live = false;
        }
    }

    /// <summary>Folds a column or opens it, and remembers that for this project.</summary>
    [RelayCommand]
    public void ToggleCollapsed(BoardColumn column)
    {
        ArgumentNullException.ThrowIfNull(column);

        if (Project is { } project)
        {
            shell.RememberCollapsed(project, BoardRules.ToggleCollapsed(Collapsed(project), column.Name));
            column.Collapsed = !column.Collapsed;
        }
    }

    /// <summary>A press on a card. Redrawing under it now would replace the button before its click lands.</summary>
    public void Hold() => _held = true;

    /// <summary>The press is over, one way or another, so what waited for it can draw.</summary>
    public void LetGo()
    {
        _held = false;
        if (_drawOwed)
        {
            Draw();
        }
    }

    /// <summary>Marks the column a card held over `over`, a column or a card, would go to.</summary>
    public void Hover(BoardTile tile, string? over)
    {
        ArgumentNullException.ThrowIfNull(tile);

        var stage = BoardRules.Drop(tile.Card.Id, over, _order, _shown) switch
        {
            BoardDrop.Move move => move.Stage,
            BoardDrop.Reorder => BoardRules.ParkingLot,
            _ => null,
        };
        foreach (var column in Columns)
        {
            column.Target = column.Name == stage;
        }
    }

    /// <summary>
    /// Lets go. A move only asks: nothing here changes a card's stage, so it stays where it was until
    /// a re-read brings a board that agrees, and a refusal comes back in the server's own words. A
    /// reorder within the parking lot is the one thing shown before the server answers.
    /// </summary>
    public async Task EndDragAsync(BoardTile tile, string? over)
    {
        ArgumentNullException.ThrowIfNull(tile);

        Hover(tile, null);
        tile.Dragged = false;
        _held = false;
        switch (BoardRules.Drop(tile.Card.Id, over, _order, _shown))
        {
            case BoardDrop.Move move:
                _moving = tile.Card.Id;
                tile.Pending = true;
                await MoveAsync(tile.Card.Id, move.Stage);
                _moving = null;
                await LoadAsync(CancellationToken.None);
                break;
            case BoardDrop.Reorder reorder:
                await ReorderAsync(tile.Card.Id, reorder);
                break;
            default:
                break;
        }

        if (_drawOwed)
        {
            Draw();
        }
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        if (Projects.Count == 0 && !await LoadProjectsAsync(cancellationToken))
        {
            return;
        }

        if (Project is not { } project || shell.Connection is not { } connection)
        {
            return;
        }

        // A screen coming back has missed everything: the feed reports nothing about what happened meanwhile.
        _log.Clear();
        await LoadAsync(cancellationToken);
        _ = EveryAsync(Clock, Tick, cancellationToken);
        await connection.FollowAsync(
            "/api/feed",
            project,
            signal => Dispatcher.UIThread.InvokeAsync(() => Follow(signal, cancellationToken)).GetTask(),
            cancellationToken: cancellationToken);
    }

    partial void OnProjectChanged(string? value)
    {
        if (value is null || _choosing)
        {
            return;
        }

        shell.RememberProject(value);
        Columns.Clear();
        Live = false;
        Shown();
    }

    partial void OnFlaggedOnlyChanged(bool value) => Draw();

    partial void OnFilterChanged(string? value) => Draw();

    private async Task<bool> LoadProjectsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var projects = await shell.Connection!.Sdk.Projects.ListProjectsAsync(cancellationToken);
            foreach (var project in projects)
            {
                Projects.Add(project.Name);
            }

            // Marked, so the change of project this makes does not start a second stream.
            _choosing = true;
            Project = Projects.FirstOrDefault(name => name == shell.Settings.Project) ?? Projects.FirstOrDefault();
            _choosing = false;
            Error = Projects.Count == 0 ? "This server has no projects yet. Register one in the web app." : null;
            return true;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Could not load projects: {ApiError.Reason(failure)}";
            return false;
        }
    }

    private void Follow(StreamSignal signal, CancellationToken cancellationToken)
    {
        switch (signal)
        {
            case StreamSignal.Live:
                Live = true;
                _ = LoadSettledAsync(cancellationToken);
                break;
            case StreamSignal.Down:
                Live = false;
                break;
            case StreamSignal.Received received:
                var feedEvent = FeedEvent.Parse(received.Event.Data);
                if (feedEvent is not null)
                {
                    _log.Record(feedEvent);
                    Tick();
                }

                if (feedEvent is null || !BoardRules.IsToolType(feedEvent.Type))
                {
                    _ = LoadSettledAsync(cancellationToken);
                }

                break;
            default:
                break;
        }
    }

    private async Task MoveAsync(string card, string stage)
    {
        if (Project is not { } project || shell.Connection is not { } connection)
        {
            return;
        }

        try
        {
            using var sdk = connection.ForProject(project);
            await sdk.Board.MoveCardAsync(card, new MoveCardRequest { Stage = stage });
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Could not move the card: {ApiError.Reason(failure)}";
        }
    }

    /// <summary>Stamps the new order over the server's sparse positions until a re-read replaces them, and puts it back on a refusal.</summary>
    private async Task ReorderAsync(string card, BoardDrop.Reorder reorder)
    {
        if (Project is not { } project || shell.Connection is not { } connection)
        {
            return;
        }

        var before = _cards;
        var places = reorder.Order.Select((id, place) => (id, place)).ToDictionary(pair => pair.id, pair => pair.place);
        _cards = [.. _cards.Select(other => places.TryGetValue(other.Id, out var place) ? other with { Position = place } : other)];
        Draw();
        try
        {
            using var sdk = connection.ForProject(project);
            await sdk.Board.RepositionCardAsync(card, new RepositionCardRequest { BeforeId = reorder.BeforeId, AfterId = reorder.AfterId });
            Error = null;
            await LoadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            _cards = before;
            Error = $"Could not reorder the card: {ApiError.Reason(failure)}";
            Draw();
        }
    }

    private void Tick()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var tile in Columns.SelectMany(column => column.Cards))
        {
            tile.Tick(_log.Activity(tile.Card.Id), now);
        }
    }

    /// <summary>One reload for a burst of events, because connecting replays a snapshot of every card.</summary>
    private async Task LoadSettledAsync(CancellationToken cancellationToken)
    {
        if (_settling is { } previous)
        {
            await previous.CancelAsync();
        }

        var settling = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _settling = settling;
        try
        {
            await Task.Delay(Settle, settling.Token);
            await LoadAsync(settling.Token);
        }
        catch (OperationCanceledException) when (settling.IsCancellationRequested)
        {
            // A later event took over.
        }
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        if (Project is not { } project || shell.Connection is not { } connection)
        {
            return;
        }

        try
        {
            using var sdk = connection.ForProject(project);
            var columns = await sdk.Board.ListBoardColumnsAsync(cancellationToken);
            var cards = await sdk.Board.ListCardsAsync(cancellationToken);
            if (Project != project)
            {
                return;
            }

            _cards = cards;
            _order = BoardRules.ColumnOrder(columns, cards);
            // Only a failure of its own: a refused drop stays said after the re-read that follows it.
            if (_unread)
            {
                _unread = false;
                Error = null;
            }

            Draw();
        }
        catch (HttpRequestException failure)
        {
            _unread = true;
            Error = $"Could not load the board: {ApiError.Reason(failure)}";
        }
    }

    private void Draw()
    {
        if (_held)
        {
            _drawOwed = true;
            return;
        }

        _drawOwed = false;
        Columns.Clear();
        var cards = _cards.Where(card => (!FlaggedOnly || card.NeedsHuman) && BoardRules.Matches(card, Filter)).ToList();
        _shown = cards;
        var collapsed = Project is { } project ? Collapsed(project) : [];
        foreach (var stage in _order)
        {
            var inStage = BoardRules.Sorted(stage, cards.Where(card => card.Stage == stage));
            if (!FlaggedOnly || inStage.Count > 0)
            {
                Columns.Add(new BoardColumn(stage, [.. inStage.Select(Tile)]) { Collapsed = collapsed.Contains(stage) });
            }
        }

        Count = BoardRules.CountLabel(cards.Count, _cards.Count, cards.Count != _cards.Count);
        Tick();
    }

    private IReadOnlyList<string> Collapsed(string project) => shell.Settings.Collapsed.GetValueOrDefault(project) ?? [];

    private BoardTile Tile(CardSummary card)
    {
        var blockedBy = BoardRules.UnfinishedDeps(card, _cards);
        var pieces = BoardRules.Split(card, _cards);
        return new BoardTile(
            card,
            card.NeedsHuman ? card.NeedsHumanReason ?? "Needs you" : null,
            blockedBy.Count > 0 ? $"blocked on {string.Join(", ", blockedBy)}" : null,
            blockedBy.Count == 0 && card.DependsOn.Count > 0 ? $"{card.DependsOn.Count} deps" : null,
            pieces is null ? null : $"{pieces.Merged}/{pieces.Total} pieces")
        {
            Pending = card.Id == _moving,
        };
    }
}
