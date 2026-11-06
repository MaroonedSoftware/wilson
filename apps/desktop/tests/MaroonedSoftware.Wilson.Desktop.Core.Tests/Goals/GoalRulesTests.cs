using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Goals;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Goals;

public sealed class GoalRulesTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);

    private static Goal Goal(string id, GoalStatus status, int minutesAgo = 0) => new()
    {
        Id = id,
        ThreadId = $"t{id}",
        Project = "wilson",
        Title = $"Goal {id}",
        Outcome = "Done looks like this.",
        Status = status,
        CreatedAt = Now.AddDays(-1),
        UpdatedAt = Now.AddMinutes(-minutesAgo),
    };

    [Theory]
    [InlineData(GoalStatus.Active, true)]
    [InlineData(GoalStatus.Paused, true)]
    [InlineData(GoalStatus.Done, false)]
    [InlineData(GoalStatus.Abandoned, false)]
    [InlineData(GoalStatus.Unknown, false)]
    public void Open_is_active_or_paused_as_on_the_web(GoalStatus status, bool open) =>
        Assert.Equal(open, GoalRules.IsOpen(Goal("1", status)));

    [Theory]
    [InlineData(GoalStatus.Active, "green")]
    [InlineData(GoalStatus.Paused, "yellow")]
    [InlineData(GoalStatus.Done, "blue")]
    [InlineData(GoalStatus.Abandoned, "gray")]
    [InlineData(GoalStatus.Unknown, "gray")]
    public void Each_status_has_the_web_s_colour(GoalStatus status, string color) =>
        Assert.Equal(color, GoalRules.StatusColor(status));

    [Fact]
    public void Statuses_are_said_as_the_server_spells_them()
    {
        Assert.Equal(["active", "paused", "done", "abandoned"], new[] { GoalStatus.Active, GoalStatus.Paused, GoalStatus.Done, GoalStatus.Abandoned }.Select(GoalRules.StatusText));
        Assert.Equal("unknown", GoalRules.StatusText(GoalStatus.Unknown));
    }

    [Fact]
    public void Refreshes_as_often_as_the_web_app() => Assert.Equal(TimeSpan.FromMilliseconds(10_000), GoalRules.Refresh);

    [Fact]
    public void Split_puts_open_goals_first_each_newest_first()
    {
        var (open, finished) = GoalRules.Split([
            Goal("1", GoalStatus.Done, 30),
            Goal("2", GoalStatus.Active, 20),
            Goal("3", GoalStatus.Abandoned, 5),
            Goal("4", GoalStatus.Paused, 1),
            Goal("5", GoalStatus.Active, 60),
        ]);

        Assert.Equal(["4", "2", "5"], open.Select(goal => goal.Id));
        Assert.Equal(["3", "1"], finished.Select(goal => goal.Id));
    }

    [Fact]
    public void Nothing_splits_into_nothing()
    {
        var (open, finished) = GoalRules.Split([]);

        Assert.Empty(open);
        Assert.Empty(finished);
    }

    [Fact]
    public void A_goal_reads_from_the_wire()
    {
        const string body = """
            [{"id":"7","threadId":"12","project":"wilson","title":"Desktop goals","outcome":"The app shows goals.","status":"paused","createdAt":"2026-11-05T18:00:00.000Z","updatedAt":"2026-11-06T09:30:00.000Z"},
             {"id":"8","threadId":"13","project":"other","title":"Later","outcome":"x","status":"archived","createdAt":"2026-11-05T18:00:00.000Z","updatedAt":"2026-11-05T18:00:00.000Z"}]
            """;

        var goals = JsonSerializer.Deserialize<List<Goal>>(body, SdkJson.Options)!;

        Assert.Equal("7", goals[0].Id);
        Assert.Equal("12", goals[0].ThreadId);
        Assert.Equal("wilson", goals[0].Project);
        Assert.Equal("Desktop goals", goals[0].Title);
        Assert.Equal("The app shows goals.", goals[0].Outcome);
        Assert.Equal(GoalStatus.Paused, goals[0].Status);
        Assert.Equal(new DateTimeOffset(2026, 11, 6, 9, 30, 0, TimeSpan.Zero), goals[0].UpdatedAt);
        Assert.Equal(GoalStatus.Unknown, goals[1].Status);
        Assert.False(GoalRules.IsOpen(goals[1]));
    }
}
