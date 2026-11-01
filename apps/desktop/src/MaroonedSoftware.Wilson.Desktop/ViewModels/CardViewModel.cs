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

/// <summary>One line of a card's activity.</summary>
public sealed record EventLine(string When, string What);

/// <summary>
/// One card. Actions are offered as the web app offers them: whatever applies is the server's to
/// decide, a refusal comes back in its own words, and only a re-read ever changes the stage shown.
/// </summary>
public sealed partial class CardViewModel(ShellViewModel shell, string project, string id) : PageViewModel
{
    private const long EventLimit = 100;
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);

    private readonly WilsonSdk _sdk = shell.Connection!.ForProject(project);
    private Func<Task>? _confirmed;

    public ObservableCollection<EventLine> Events { get; } = [];

    public ObservableCollection<string> Stages { get; } = [];

    public ShellViewModel Shell => shell;

    public string Id => id;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanPlan))]
    private CardDetail? _card;

    [ObservableProperty]
    private string? _usage;

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

    public bool CanPlan => Card?.Stage is "planning" or BoardRules.ParkingLot;

    [RelayCommand]
    public Task AcknowledgeAsync() => ActAsync("Acknowledged.", token => _sdk.Board.AcknowledgeAFlaggedCardAsync(id, token));

    [RelayCommand]
    public Task ApproveAsync() => ActAsync("Plan approved.", token => _sdk.Board.ApproveCardPlanAsync(id, token));

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
    public void OpenPlan() => shell.Push(new PlanViewModel(shell, project, id));

    [RelayCommand]
    public void Edit() => shell.Push(new CardFormViewModel(shell, project, id));

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await LoadAsync(cancellationToken);
        if (Stages.Count == 0)
        {
            await LoadStagesAsync(cancellationToken);
        }

        CancellationTokenSource? settling = null;
        await shell.Connection!.FollowAsync(
            "/api/feed",
            project,
            signal =>
            {
                if (signal is StreamSignal.Received received && BoardRules.FeedCardId(received.Event.Data) == id)
                {
                    settling?.Cancel();
                    settling = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    var token = settling.Token;
                    _ = Dispatcher.UIThread.InvokeAsync(() => ReloadSettledAsync(token));
                }

                return Task.CompletedTask;
            },
            cancellationToken: cancellationToken);
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
            var events = await _sdk.Board.ListCardEventsAsync(id, new ListQuery { Limit = EventLimit }, cancellationToken);
            Card = card;
            FlagReason = card.NeedsHuman ? card.NeedsHumanReason ?? "This card is flagged for a human." : null;
            Events.Clear();
            foreach (var entry in events)
            {
                var when = entry.CreatedAt.ToLocalTime().ToString("d MMM HH:mm", CultureInfo.CurrentCulture);
                Events.Add(new EventLine(when, entry.Stage is null ? entry.Type : $"{entry.Type} ({entry.Stage})"));
            }

            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
            return;
        }

        try
        {
            var usage = await _sdk.Board.GetCardUsageAsync(id, cancellationToken);
            Usage = string.Create(CultureInfo.CurrentCulture, $"{usage.Total.Attempts:N0} attempts, {usage.Total.InputTokens:N0} tokens in, {usage.Total.OutputTokens:N0} out");
        }
        catch (HttpRequestException)
        {
            // Usage is a footnote, and a card without it is still a card.
            Usage = null;
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

    private async Task ActAsync<T>(string done, Func<CancellationToken, Task<T>> action)
    {
        Acting = done;
        Notice = null;
        string note;
        try
        {
            await action(CancellationToken.None);
            note = done;
        }
        catch (HttpRequestException failure)
        {
            note = ApiError.Reason(failure);
        }

        await LoadAsync(CancellationToken.None);
        Acting = null;
        Notice = note;
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
