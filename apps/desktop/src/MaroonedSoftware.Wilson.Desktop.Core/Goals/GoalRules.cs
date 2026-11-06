using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Goals;

/// <summary>What `lib/goals.ts` says about a goal, kept in step by hand.</summary>
public static class GoalRules
{
    /// <summary>`GOAL_REFRESH_MS`: the card feed is per project and the goals page has none open, so it polls.</summary>
    public static readonly TimeSpan Refresh = TimeSpan.FromSeconds(10);

    /// <summary>`isOpen`: whether a goal is still being worked.</summary>
    public static bool IsOpen(Goal goal)
    {
        ArgumentNullException.ThrowIfNull(goal);

        return goal.Status is GoalStatus.Active or GoalStatus.Paused;
    }

    /// <summary>`statusColor`: the Mantine colour the web app's badge is drawn in. A status this build does not know is gray.</summary>
    public static string StatusColor(GoalStatus status) => status switch
    {
        GoalStatus.Active => "green",
        GoalStatus.Paused => "yellow",
        GoalStatus.Done => "blue",
        _ => "gray",
    };

    /// <summary>The status as the badge says it, the wire spelling as the web app shows it.</summary>
    public static string StatusText(GoalStatus status) => status switch
    {
        GoalStatus.Active => "active",
        GoalStatus.Paused => "paused",
        GoalStatus.Done => "done",
        GoalStatus.Abandoned => "abandoned",
        _ => "unknown",
    };

    /// <summary>Most recently changed first, as the API answers, so a list built elsewhere reads the same.</summary>
    public static IReadOnlyList<Goal> Newest(IEnumerable<Goal> goals)
    {
        ArgumentNullException.ThrowIfNull(goals);

        return goals.OrderByDescending(goal => goal.UpdatedAt).ToList();
    }

    /// <summary>The web page's two lists: what is still open, then what is finished, each newest first.</summary>
    public static (IReadOnlyList<Goal> Open, IReadOnlyList<Goal> Finished) Split(IEnumerable<Goal> goals)
    {
        var ordered = Newest(goals);
        return (ordered.Where(IsOpen).ToList(), ordered.Where(goal => !IsOpen(goal)).ToList());
    }
}
