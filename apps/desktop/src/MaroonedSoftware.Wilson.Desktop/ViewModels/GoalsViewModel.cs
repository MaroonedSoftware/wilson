using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Goals;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// A goal as `GoalRow` in `routes/goals.index.tsx` draws it. One flag per status, so the badge takes
/// `statusColor`'s colour: green, yellow, blue and gray.
/// </summary>
public sealed record GoalRow(string Id, string Title, string Outcome, string Project, string Status, bool Active, bool Paused, bool Done, bool Abandoned)
{
    public static GoalRow From(Goal goal)
    {
        ArgumentNullException.ThrowIfNull(goal);

        var color = GoalRules.StatusColor(goal.Status);
        return new GoalRow(goal.Id, goal.Title, goal.Outcome, goal.Project, GoalRules.StatusText(goal.Status), color == "green", color == "yellow", color == "blue", color == "gray");
    }
}

/// <summary>
/// `routes/goals.index.tsx`: what the chat is seeing through, across every project, with what is still
/// open first. Goals belong to no one project here, so it reads through the unscoped client. Nothing in
/// the feed says a goal changed, so it reads again every <see cref="GoalRules.Refresh"/>, as the web app does.
/// </summary>
public sealed partial class GoalsViewModel(ShellViewModel shell) : PageViewModel
{
    /// <summary>Active and paused, newest first.</summary>
    public ObservableCollection<GoalRow> Open { get; } = [];

    /// <summary>Done and abandoned, newest first, under "Finished".</summary>
    public ObservableCollection<GoalRow> Finished { get; } = [];

    [ObservableProperty]
    private string? _error;

    /// <summary>Until the first answer, as the web page shows its skeleton.</summary>
    [ObservableProperty]
    private bool _loading = true;

    [ObservableProperty]
    private bool _noGoals;

    [ObservableProperty]
    private bool _hasFinished;

    /// <summary>What the server says now. A failed read keeps the rows last drawn and says why above them.</summary>
    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var goals = await new GoalReads(shell.Connection!.Sdk).ListAsync(cancellationToken: cancellationToken);
            Draw(goals);
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load goals: {ApiError.Reason(failure)}";
        }
        finally
        {
            Loading = false;
        }
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await ReadAsync(cancellationToken);
        await EveryAsync(GoalRules.Refresh, () => _ = ReadQuietlyAsync(cancellationToken), cancellationToken);
    }

    private async Task ReadQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ReadAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the page is how its reading ends.
        }
    }

    private void Draw(IReadOnlyList<Goal> goals)
    {
        var (open, finished) = GoalRules.Split(goals);
        Replace(Open, open.Select(GoalRow.From).ToList());
        Replace(Finished, finished.Select(GoalRow.From).ToList());
        NoGoals = goals.Count == 0;
        HasFinished = Finished.Count > 0;
    }

    /// <summary>Only when something changed, so a read every ten seconds does not redraw the list under the pointer.</summary>
    private static void Replace(ObservableCollection<GoalRow> shown, IReadOnlyList<GoalRow> rows)
    {
        if (shown.SequenceEqual(rows))
        {
            return;
        }

        shown.Clear();
        foreach (var row in rows)
        {
            shown.Add(row);
        }
    }
}
