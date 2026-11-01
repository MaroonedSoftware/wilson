using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One column of the board, as drawn.</summary>
public sealed record BoardColumn(string Name, IReadOnlyList<CardSummary> Cards)
{
    public string Count { get; } = Cards.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>A project's cards, kept live from the feed for as long as the board is in front.</summary>
public sealed partial class BoardViewModel(ShellViewModel shell) : PageViewModel
{
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);

    private IReadOnlyList<CardSummary> _cards = [];
    private IReadOnlyList<string> _order = [];
    private CancellationTokenSource? _settling;
    private bool _choosing;

    public ObservableCollection<string> Projects { get; } = [];

    public ObservableCollection<BoardColumn> Columns { get; } = [];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    private string? _project;

    [ObservableProperty]
    private bool _flaggedOnly;

    [ObservableProperty]
    private bool _live;

    [ObservableProperty]
    private string? _error;

    public string Server => shell.Connection?.Origin ?? string.Empty;

    [RelayCommand]
    public Task RefreshAsync() => LoadAsync(CancellationToken.None);

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
        await LoadAsync(cancellationToken);
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
            case StreamSignal.Received received when !BoardRules.IsToolEvent(received.Event.Data):
                _ = LoadSettledAsync(cancellationToken);
                break;
            default:
                break;
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
            Error = null;
            Draw();
        }
        catch (HttpRequestException failure)
        {
            Error = $"Could not load the board: {ApiError.Reason(failure)}";
        }
    }

    private void Draw()
    {
        Columns.Clear();
        var cards = _cards.Where(card => !FlaggedOnly || card.NeedsHuman).ToList();
        foreach (var stage in _order)
        {
            var inStage = BoardRules.Sorted(stage, cards.Where(card => card.Stage == stage));
            if (!FlaggedOnly || inStage.Count > 0)
            {
                Columns.Add(new BoardColumn(stage, inStage));
            }
        }
    }
}
