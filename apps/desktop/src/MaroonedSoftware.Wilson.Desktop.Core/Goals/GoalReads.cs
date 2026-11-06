using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Goals;

/// <summary>
/// `GET /api/goals` through the connection's own SDK, as every other page reads. Goals are not per project
/// in the list, so this takes the unscoped client and never `ForProject`.
/// </summary>
public sealed class GoalReads(WilsonSdk sdk)
{
    /// <summary>Every goal, or those with one status or on one thread, most recently changed first.</summary>
    /// <exception cref="ArgumentOutOfRangeException">For <see cref="GoalStatus.Unknown"/>, which has no wire spelling to filter by.</exception>
    public async Task<IReadOnlyList<Goal>> ListAsync(GoalStatus? status = null, string? threadId = null, CancellationToken cancellationToken = default)
    {
        var query = status is null && threadId is null
            ? null
            : new ListGoalsQuery { Status = status is { } wanted ? Filter(wanted) : null, ThreadId = threadId };
        return GoalRules.Newest(await sdk.Goals.ListGoalsAsync(query, cancellationToken).ConfigureAwait(false));
    }

    private static ListGoalsQueryStatus Filter(GoalStatus status) => status switch
    {
        GoalStatus.Active => ListGoalsQueryStatus.Active,
        GoalStatus.Paused => ListGoalsQueryStatus.Paused,
        GoalStatus.Done => ListGoalsQueryStatus.Done,
        GoalStatus.Abandoned => ListGoalsQueryStatus.Abandoned,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, "A status the server does not name cannot be filtered by."),
    };
}
