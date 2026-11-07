using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Diff;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One line of a card's activity.</summary>
public sealed record EventLine(string When, string What, string? Stage, string? Detail);

/// <summary>An acceptance criterion, and what the latest review said of it.</summary>
public sealed record CriterionLine(string Id, string Text, string? Status);

/// <summary>One run of a stage, as drawn.</summary>
public sealed record AttemptLine(string Stage, string Outcome, string When, string Tally, IReadOnlyList<string> Failures, string? FinalMessage, string? Reads);

/// <summary>One row of the usage table.</summary>
public sealed record UsageLine(string Stage, string Attempts, string Input, string Output, bool Total);

/// <summary>One of the card's versions.</summary>
public sealed record VersionLine(string Message, string When);

/// <summary>A comment on a line, held here until the whole batch is sent.</summary>
public sealed record FindingLine(HumanFinding Finding, string Severity, string Where, CardViewModel Page);

/// <summary>A context snapshot's manifest. Its content is for the planning agent, and is not drawn.</summary>
public sealed record ContextLine(string Id, string? Title, string Source, string Fetched, CardViewModel Page);

/// <summary>A card this one depends on.</summary>
public sealed record DependencyLine(string Id, CardViewModel Page);

/// <summary>A card split out of this one. It carries the page because the list's own context is the row.</summary>
public sealed record PieceLine(string Id, string Stage, string Title, CardViewModel Page);

/// <summary>One tool call, as drawn.</summary>
public sealed record ToolLine(string Tool, string Label, string When);

/// <summary>One line of a diff, as drawn.</summary>
public sealed record DiffRow(string Old, string New, string Text, bool IsAdded, bool IsRemoved, bool IsHunk, int? NewNumber)
{
    public static DiffRow Of(PatchLine line)
    {
        ArgumentNullException.ThrowIfNull(line);

        return new DiffRow(
            line.OldNumber?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            line.NewNumber?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            line.Text,
            line.Kind == PatchLineKind.Added,
            line.Kind == PatchLineKind.Removed,
            line.Kind is PatchLineKind.Hunk or PatchLineKind.Note,
            Patch.Commentable(line) ? line.NewNumber : null);
    }
}

/// <summary>
/// One card. Actions are offered as the web app offers them: whatever applies is the server's to
/// decide, a refusal comes back in its own words, and only a re-read ever changes the stage shown.
/// </summary>
public sealed partial class CardViewModel(ShellViewModel shell, string project, string id) : PageViewModel, IFollowsFeed
{
    private const long HistoryLimit = 100;
    private const int DiffTab = 2;
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan Clock = TimeSpan.FromSeconds(10);

    private readonly WilsonSdk _sdk = shell.Connection!.ForProject(project);
    private readonly CardFeedLog _log = new();
    private List<CardEvent> _seed = [];
    private CancellationTokenSource? _settling;
    private Func<Task>? _confirmed;

    public ObservableCollection<EventLine> Events { get; } = [];

    public ObservableCollection<string> Scope { get; } = [];

    public ObservableCollection<CriterionLine> Criteria { get; } = [];

    public ObservableCollection<AttemptLine> Attempts { get; } = [];

    public ObservableCollection<UsageLine> UsageRows { get; } = [];

    public ObservableCollection<VersionLine> Versions { get; } = [];

    public ObservableCollection<PieceLine> Pieces { get; } = [];

    public ObservableCollection<ContextLine> Context { get; } = [];

    public ObservableCollection<FindingLine> Findings { get; } = [];

    public ObservableCollection<DependencyLine> Dependencies { get; } = [];

    public ObservableCollection<ToolLine> Tools { get; } = [];

    public ObservableCollection<string> Stages { get; } = [];

    public ObservableCollection<CardDiffFile> DiffFiles { get; } = [];

    public ObservableCollection<DiffRow> DiffRows { get; } = [];

    public ShellViewModel Shell => shell;

    public string Id => id;

    public string Project => project;

    [ObservableProperty]
    private int _selectedTab;

    [ObservableProperty]
    private CardDiffFile? _selectedFile;

    [ObservableProperty]
    private string? _diffNote;

    [ObservableProperty]
    private string? _fileNote;

    [ObservableProperty]
    private string _answer = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Question))]
    [NotifyPropertyChangedFor(nameof(QuestionFrom))]
    [NotifyPropertyChangedFor(nameof(QuestionTried))]
    [NotifyPropertyChangedFor(nameof(CanPlan))]
    [NotifyPropertyChangedFor(nameof(PlanCheck))]
    [NotifyPropertyChangedFor(nameof(MergeStatus))]
    [NotifyPropertyChangedFor(nameof(MergeStatusWarns))]
    [NotifyPropertyChangedFor(nameof(CanSplit))]
    [NotifyPropertyChangedFor(nameof(SplitFrom))]
    [NotifyPropertyChangedFor(nameof(PullRequest))]
    [NotifyPropertyChangedFor(nameof(CanMerge))]
    private CardDetail? _card;

    [ObservableProperty]
    private bool _live;

    [ObservableProperty]
    private string? _toolsNote = "No tool calls yet.";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Composing))]
    private DiffRow? _selectedRow;

    [ObservableProperty]
    private bool _concern;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddFindingCommand))]
    private string? _problem;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddFindingCommand))]
    private string? _suggestion;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AttachContextCommand))]
    private string? _contextUrl;

    [ObservableProperty]
    private string? _contextNote;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddDependencyCommand))]
    private string? _newDependency;

    [ObservableProperty]
    private string? _usageNote;

    [ObservableProperty]
    private string? _eventsNote;

    [ObservableProperty]
    private string? _versionsNote;

    [ObservableProperty]
    private string? _attemptsNote;

    [ObservableProperty]
    private string? _ranOn;

    [ObservableProperty]
    private bool _hasSplit;

    [ObservableProperty]
    private string? _flagReason;

    [ObservableProperty]
    private string? _moveTo;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private string? _acting;

    [ObservableProperty]
    private string? _notice;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private string? _confirming;

    public bool Idle => Acting is null;

    public string? SplitFrom => Card?.SplitFrom;

    public bool Composing => SelectedRow?.NewNumber is not null;

    public string ComposingOn => SelectedRow?.NewNumber is { } line ? $"{SelectedFile?.Path}:{line}" : string.Empty;

    public string SubmitFindingsLabel => Findings.Count == 1 ? "Submit 1 comment" : $"Submit {Findings.Count} comments";

    /// <summary>A question the stage stopped to ask, waiting for an answer. Absent on any other flag.</summary>
    public CardBlocked? Question => Card?.Blocked;

    public string? QuestionFrom => Card?.Blocked is { } blocked ? $"{blocked.Stage} stopped to ask" : null;

    public string? QuestionTried => Card?.Blocked is { } blocked ? $"Already tried: {blocked.Tried}" : null;

    public bool CanPlan => Card?.Stage is "planning" or BoardRules.ParkingLot;

    public string? PlanCheck => BoardRules.PlanCheck(Card?.PlanCheck, Card?.PlanCheckReason);

    public string? MergeStatus => BoardRules.MergeStatusLine(Card?.MergeStatus);

    public bool MergeStatusWarns => BoardRules.MergeStatusWarns(Card?.MergeStatus);

    public bool CanSplit => Card?.PlanCheck == CardSummaryPlanCheck.Refused;

    /// <summary>The card's open or merged pull request, as its button's label. It takes Merge's place.</summary>
    public string? PullRequest => BoardRules.PullRequestLabel(Card?.PullRequest);

    public bool CanMerge => PullRequest is null;

    /// <summary>Opens the card's pull request on GitHub. Only an https link is opened.</summary>
    [RelayCommand]
    public void OpenPullRequest()
    {
        if (Card?.PullRequest?.Url is { } url && url.StartsWith("https://", StringComparison.Ordinal))
        {
            using var opened = Process.Start(new ProcessStartInfo("open") { ArgumentList = { url } });
        }
    }

    [RelayCommand]
    public Task AcknowledgeAsync() => ActAsync("Acknowledged.", token => _sdk.Board.AcknowledgeAFlaggedCardAsync(id, token));

    /// <summary>A likely answer fills the box rather than sends, so it can be reworded first.</summary>
    [RelayCommand]
    public void UseOption(string option) => Answer = option;

    /// <summary>The stage runs again in a fresh session, with the answer in its plan, when next dispatched.</summary>
    [RelayCommand]
    public Task SendAnswerAsync() =>
        string.IsNullOrWhiteSpace(Answer)
            ? Task.CompletedTask
            : ActAsync(
                "Answered. It runs again when next dispatched.",
                token => _sdk.Board.AnswerABlockedCardAsync(id, new AnswerCardRequest { Answer = Answer }, token));

    [RelayCommand]
    public Task ApproveAsync() => ActAsync("Plan approved. Checking its scope.", token => _sdk.Board.ApproveCardPlanAsync(id, token));

    [RelayCommand]
    public Task SplitAsync() =>
        ActAsync("Split as proposed.", async token =>
        {
            var division = await _sdk.Board.GetCardDivisionAsync(id, token);
            return await _sdk.Board.SplitCardAsync(id, new SplitCardsRequest { Pieces = division.Pieces }, token);
        });

    [RelayCommand]
    public Task StartAsync() => ActAsync("Queued for its stage.", token => _sdk.Board.StartCardAsync(id, token));

    [RelayCommand]
    public Task MoveAsync() =>
        MoveTo is { } stage ? ActAsync($"Moved to {stage}.", token => _sdk.Board.MoveCardAsync(id, new MoveCardRequest { Stage = stage }, token)) : Task.CompletedTask;

    /// <summary>Merging asks first: it lands on main, and it runs the suite before answering.</summary>
    [RelayCommand]
    public void AskMerge()
    {
        Confirming = "Merge this card to main? The test suite runs first, which can take a while.";
        _confirmed = MergeAsync;
    }

    [RelayCommand]
    public void AskRelease()
    {
        Confirming = "Release this card?";
        _confirmed = () => ActAsync("Released.", token => _sdk.Board.ReleaseCardAsync(id, token));
    }

    [RelayCommand]
    public Task ConfirmAsync()
    {
        var confirmed = _confirmed;
        CancelConfirm();
        return confirmed?.Invoke() ?? Task.CompletedTask;
    }

    [RelayCommand]
    public void CancelConfirm()
    {
        Confirming = null;
        _confirmed = null;
    }

    [RelayCommand]
    public Task RefreshAsync() => LoadAsync(CancellationToken.None);

    /// <summary>A card linked from this one, in this project.</summary>
    [RelayCommand]
    public void OpenCard(string other)
    {
        ArgumentException.ThrowIfNullOrEmpty(other);

        shell.Push(new CardViewModel(shell, project, other));
    }

    private bool CanAddFinding => !string.IsNullOrWhiteSpace(Problem) && !string.IsNullOrWhiteSpace(Suggestion);

    private bool CanAttach => !string.IsNullOrWhiteSpace(ContextUrl);

    private bool CanAddDependency => !string.IsNullOrWhiteSpace(NewDependency);

    [RelayCommand(CanExecute = nameof(CanAddFinding))]
    public void AddFinding()
    {
        if (SelectedFile is not { } file || SelectedRow?.NewNumber is not { } line)
        {
            return;
        }

        var severity = Concern ? HumanFindingSeverity.Concern : HumanFindingSeverity.Blocker;
        var finding = new HumanFinding { File = file.Path, Line = line, Severity = severity, Problem = Problem!.Trim(), Suggestion = Suggestion!.Trim() };
        Findings.Add(new FindingLine(finding, Concern ? "concern" : "blocker", $"{file.Path}:{line}", this));
        CancelFinding();
        OnPropertyChanged(nameof(SubmitFindingsLabel));
    }

    [RelayCommand]
    public void CancelFinding()
    {
        SelectedRow = null;
        Problem = null;
        Suggestion = null;
        Concern = false;
    }

    [RelayCommand]
    public void RemoveFinding(FindingLine finding)
    {
        Findings.Remove(finding);
        OnPropertyChanged(nameof(SubmitFindingsLabel));
    }

    /// <summary>One request for the batch, as the server moves the card once. A refusal keeps every comment.</summary>
    [RelayCommand]
    public async Task SubmitFindingsAsync()
    {
        var findings = new RecordFindingsRequest { Findings = [.. Findings.Select(finding => finding.Finding)] };
        var count = findings.Findings.Count;
        if (await ActAsync(count == 1 ? "Comment sent." : $"{count} comments sent.", token => _sdk.Board.RecordFindingsAsync(id, findings, token)))
        {
            Findings.Clear();
            OnPropertyChanged(nameof(SubmitFindingsLabel));
        }
    }

    /// <summary>A refusal leaves the address in the box, to fix and send again.</summary>
    [RelayCommand(CanExecute = nameof(CanAttach))]
    public async Task AttachContextAsync()
    {
        var url = ContextUrl!.Trim();
        if (await ActAsync("Context attached.", token => _sdk.Context.AttachContextToACardAsync(id, new AttachContextRequest { SourceUrl = url }, token)))
        {
            ContextUrl = null;
        }
    }

    [RelayCommand]
    public void AskRemoveContext(ContextLine snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        Confirming = $"Remove the snapshot fetched from {snapshot.Source}? It can be attached again, which fetches it again.";
        _confirmed = () => ActAsync("Snapshot removed.", async token =>
        {
            await _sdk.Context.RemoveAContextSnapshotAsync(id, snapshot.Id, token);
            return true;
        });
    }

    [RelayCommand(CanExecute = nameof(CanAddDependency))]
    public async Task AddDependencyAsync()
    {
        var other = NewDependency!.Trim();
        if (await ActAsync($"Depends on {other}.", token => _sdk.Board.SetCardDependencyAsync(id, new DependCardRequest { DependsOnId = other }, token)))
        {
            NewDependency = null;
        }
    }

    [RelayCommand]
    public Task RemoveDependencyAsync(DependencyLine dependency)
    {
        ArgumentNullException.ThrowIfNull(dependency);

        return ActAsync($"No longer depends on {dependency.Id}.", token => _sdk.Board.SetCardDependencyAsync(id, new DependCardRequest { DependsOnId = dependency.Id, Remove = true }, token));
    }

    [RelayCommand]
    public void OpenPlan() => shell.Push(new PlanViewModel(shell, project, id));

    [RelayCommand]
    public void Edit() => shell.Push(new CardFormViewModel(shell, project, id));

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        _log.Clear();
        await LoadAsync(cancellationToken);
        if (Stages.Count == 0)
        {
            await LoadStagesAsync(cancellationToken);
        }

        _ = EveryAsync(Clock, DrawTools, cancellationToken);
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

    partial void OnSelectedTabChanged(int value)
    {
        if (value == DiffTab)
        {
            _ = LoadDiffAsync();
        }
    }

    partial void OnSelectedFileChanged(CardDiffFile? value)
    {
        DiffRows.Clear();
        foreach (var line in Patch.Parse(value?.Patch ?? string.Empty))
        {
            DiffRows.Add(DiffRow.Of(line));
        }

        FileNote = value switch
        {
            null => null,
            { Truncated: true } => "This file's diff is too large to show here.",
            _ when DiffRows.Count == 0 => "No text hunks to show (binary content, or no changes to this file's text).",
            _ => null,
        };
    }

    partial void OnSelectedRowChanged(DiffRow? value) => OnPropertyChanged(nameof(ComposingOn));

    private async Task LoadDiffAsync()
    {
        DiffNote = "Reading the diff.";
        try
        {
            var diff = await _sdk.Board.GetCardDiffAsync(id);
            var selected = SelectedFile?.Path;
            DiffFiles.Clear();
            foreach (var file in diff.Files)
            {
                DiffFiles.Add(file);
            }

            SelectedFile = DiffFiles.FirstOrDefault(file => file.Path == selected) ?? DiffFiles.FirstOrDefault();
            DiffNote = diff.Files.Count == 0 ? "This card's branch changes nothing." : diff.Truncated ? $"Against {diff.Base[..Math.Min(8, diff.Base.Length)]}. Too large to show whole." : $"Against {diff.Base[..Math.Min(8, diff.Base.Length)]}.";
        }
        catch (HttpRequestException failure)
        {
            DiffNote = ApiError.Reason(failure);
        }
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
            case StreamSignal.Received received:
                var feedEvent = FeedEvent.Parse(received.Event.Data);
                if ((feedEvent?.CardId ?? BoardRules.FeedCardId(received.Event.Data)) != id || cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                if (feedEvent is not null)
                {
                    _log.Record(feedEvent);
                    DrawTools();
                }

                if (feedEvent is null || !BoardRules.IsToolType(feedEvent.Type))
                {
                    _settling?.Cancel();
                    _settling = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    _ = ReloadSettledAsync(_settling.Token);
                }

                break;
            default:
                break;
        }
    }

    private void DrawTools()
    {
        var rows = ToolRows.Merge(_seed, _log.Tools(id));
        var now = DateTimeOffset.UtcNow;
        Tools.Clear();
        foreach (var row in rows)
        {
            Tools.Add(new ToolLine(row.Tool, row.Label, BoardRules.EventAge(row.At, now)));
        }

        ToolsNote = rows.Count == 0 ? "No tool calls yet."
            : rows.Count >= CardFeedLog.MostToolEvents ? $"Showing the most recent {CardFeedLog.MostToolEvents} tool calls. More may exist."
            : null;
    }

    private async Task ReloadSettledAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(Settle, cancellationToken);
            await LoadAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // A later event took over, or the page was left.
        }
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var card = await _sdk.Board.GetCardAsync(id, cancellationToken);
            var events = await _sdk.Board.ListCardEventsAsync(id, new ListQuery { Limit = HistoryLimit }, cancellationToken);
            Card = card;
            FlagReason = card is { NeedsHuman: true, Blocked: null } ? card.NeedsHumanReason ?? "This card is flagged for a human." : null;
            // Kept while the question stands, so a refused answer can be sent again.
            if (card.Blocked is null)
            {
                Answer = string.Empty;
            }

            Draw(card, events);
            _seed = events;
            DrawTools();
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
            return;
        }

        await LoadContextAsync(cancellationToken);
        await LoadVersionsAsync(cancellationToken);
        await LoadUsageAsync(cancellationToken);
    }

    private void Draw(CardDetail card, List<CardEvent> events)
    {
        Reset(Scope, CardSections.FilesInScope(card.Sections.GetValueOrDefault(CardSections.FilesInScopeKey)));

        var statuses = CardSections.ReviewStatuses(events);
        Reset(Criteria, CardSections.AcceptanceCriteria(card.Sections.GetValueOrDefault(CardSections.AcceptanceCriteriaKey))
            .Select(criterion => new CriterionLine(criterion.Id, criterion.Text, statuses.GetValueOrDefault(criterion.Id))));

        Reset(Dependencies, card.DependsOn.Select(other => new DependencyLine(other, this)));
        RanOn = CardSections.LastStageHost(events) is { } host ? $"ran on {host}" : null;
        Reset(Pieces, (card.Pieces ?? []).Select(piece => new PieceLine(piece.Id, piece.Stage, piece.Title, this)));
        HasSplit = card.SplitFrom is not null || Pieces.Count > 0;

        var attempts = CardAttempts.Group(events);
        Reset(Attempts, attempts.Select(attempt => new AttemptLine(
            attempt.Stage,
            attempt.Outcome,
            When(attempt.StartedAt),
            attempt.Tally,
            attempt.Failures,
            attempt.FinalMessage,
            attempt.ReadPaths.Count > 0 ? string.Join("  ", attempt.ReadPaths) : null)));
        AttemptsNote = attempts.Count == 0 ? "No attempts yet." : null;

        // The API returns its tail oldest first, and someone chasing a stuck card starts at the end of it.
        Reset(Events, Enumerable.Reverse(events).Select(entry => new EventLine(When(entry.CreatedAt), entry.Type, entry.Stage, CardSections.EventDetail(entry))));
        EventsNote = events.Count == 0 ? "No events yet."
            : events.Count >= HistoryLimit ? $"Showing the most recent {HistoryLimit} events. More may exist."
            : null;
    }

    private async Task LoadContextAsync(CancellationToken cancellationToken)
    {
        try
        {
            var snapshots = await _sdk.Context.ListCardContextAsync(id, cancellationToken);
            Reset(Context, snapshots.Select(snapshot => new ContextLine(snapshot.Id, snapshot.Title, snapshot.SourceUrl, $"Fetched {When(snapshot.FetchedAt)} by {snapshot.FetchedBy}", this)));
            ContextNote = snapshots.Count == 0 ? "Nothing attached." : null;
        }
        catch (HttpRequestException failure)
        {
            Context.Clear();
            ContextNote = $"Could not load context: {ApiError.Reason(failure)}";
        }
    }

    private async Task LoadVersionsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var versions = await _sdk.Board.ListCardVersionsAsync(id, new ListQuery { Limit = HistoryLimit }, cancellationToken);
            Reset(Versions, versions.Select(version => new VersionLine(version.Message, When(version.CreatedAt))));
            VersionsNote = versions.Count == 0 ? "No versions yet."
                : versions.Count >= HistoryLimit ? $"Showing the most recent {HistoryLimit} versions. More may exist."
                : null;
        }
        catch (HttpRequestException failure)
        {
            Versions.Clear();
            VersionsNote = $"Could not load versions: {ApiError.Reason(failure)}";
        }
    }

    private async Task LoadUsageAsync(CancellationToken cancellationToken)
    {
        try
        {
            var usage = await _sdk.Board.GetCardUsageAsync(id, cancellationToken);
            UsageRows.Clear();
            if (usage.Stages.Count == 0)
            {
                UsageNote = "No usage recorded yet.";
                return;
            }

            UsageNote = null;
            foreach (var stage in usage.Stages)
            {
                UsageRows.Add(Row(stage.Stage, stage.Attempts, stage.InputTokens, stage.OutputTokens, false));
            }

            UsageRows.Add(Row("Total", usage.Total.Attempts, usage.Total.InputTokens, usage.Total.OutputTokens, true));
        }
        catch (HttpRequestException failure)
        {
            UsageRows.Clear();
            UsageNote = $"Could not load usage: {ApiError.Reason(failure)}";
        }
    }

    private static UsageLine Row(string stage, long attempts, long input, long output, bool total) =>
        new(stage, attempts.ToString(CultureInfo.CurrentCulture), input.ToString("N0", CultureInfo.CurrentCulture), output.ToString("N0", CultureInfo.CurrentCulture), total);

    private static string When(DateTimeOffset at) => at.ToLocalTime().ToString("d MMM HH:mm", CultureInfo.CurrentCulture);

    private static void Reset<T>(ObservableCollection<T> rows, IEnumerable<T> items)
    {
        rows.Clear();
        foreach (var item in items)
        {
            rows.Add(item);
        }
    }

    private async Task LoadStagesAsync(CancellationToken cancellationToken)
    {
        try
        {
            var columns = await _sdk.Board.ListBoardColumnsAsync(cancellationToken);
            foreach (var stage in columns.Stages.Concat(columns.NonStages))
            {
                Stages.Add(stage);
            }
        }
        catch (HttpRequestException)
        {
            // With no stages to offer, Move stays empty and everything else still works.
        }
    }

    private async Task<bool> ActAsync<T>(string done, Func<CancellationToken, Task<T>> action)
    {
        Acting = done;
        Notice = null;
        string note;
        var acted = false;
        try
        {
            await action(CancellationToken.None);
            note = done;
            acted = true;
        }
        catch (HttpRequestException failure)
        {
            note = ApiError.Reason(failure);
        }

        await LoadAsync(CancellationToken.None);
        Acting = null;
        Notice = note;
        return acted;
    }

    private async Task MergeAsync()
    {
        Acting = "Merging";
        Notice = null;
        var outcome = await MergeOutcome.OfAsync(() => _sdk.Board.MergeCardAsync(id));
        await LoadAsync(CancellationToken.None);
        Acting = null;
        Notice = outcome.Message;
    }
}
