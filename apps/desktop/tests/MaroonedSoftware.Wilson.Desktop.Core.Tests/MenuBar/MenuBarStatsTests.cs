using MaroonedSoftware.Wilson.Desktop.Core.MenuBar;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.MenuBar;

public sealed class MenuBarStatsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 5, 12, 0, 0, TimeSpan.Zero);

    private static ProjectDayStats Day(string date, long output = 0, long input = 0, long attempts = 0, long failed = 0) => new()
    {
        Date = date,
        Attempts = attempts,
        Passed = attempts - failed,
        Failed = failed,
        Interrupted = 0,
        InputTokens = input,
        CachedInputTokens = 0,
        OutputTokens = output,
    };

    private static MenuBarProjectReading Project(
        string name,
        long attempts = 0,
        long passed = 0,
        long revised = 0,
        long input = 0,
        long cached = 0,
        ProjectDayStats[]? days = null,
        int flagged = 0) => new(
        name,
        new ProjectStats
        {
            Since = Now,
            Until = Now,
            Zone = "UTC",
            Total = new ProjectStatsTotal
            {
                Attempts = attempts,
                Passed = passed,
                Failed = attempts - passed,
                Interrupted = 0,
                InputTokens = input,
                CachedInputTokens = cached,
                OutputTokens = 0,
                Cards = 0,
            },
            Stages = [],
            Days = [.. days ?? []],
            TopCards = [],
            Conversations = [],
        },
        new ProjectGateStats
        {
            Since = Now,
            Until = Now,
            Zone = "UTC",
            Kickbacks = [],
            Failures = [],
            Revised = [new ProjectGateRevised { Stage = "review", Count = revised }],
            Challenge = new ProjectGateStatsChallenge { Upheld = 0, Overturned = 0 },
            Questions = new ProjectGateStatsQuestions { Asked = 0, Answered = 0 },
            Rules = [],
            LoopStops = 0,
            Touchpoints = [],
            FirstPass = new ProjectGateStatsFirstPass { Reached = 0, FirstPass = 0 },
            Matched = 0,
        },
        [.. Enumerable.Range(0, flagged).Select(index => new CardSummary { Id = $"{index}", Title = "card", Stage = "review", DependsOn = [], NeedsHuman = true })]);

    private static Host Host(string name, long slots, bool enabled = true, bool draining = false, int running = 0) => new()
    {
        Name = name,
        Kind = HostKind.Worker,
        Slots = slots,
        Enabled = enabled,
        Draining = draining,
        Isolated = false,
        CommandEnv = [],
        Projects = [],
        Running = [.. Enumerable.Range(0, running).Select(slot => new HostSlotUse { Slot = slot, Project = "wilson", CardId = "0001", Since = Now })],
    };

    private static DrainStatus Drain(params string[] projects) => new()
    {
        Draining = false,
        Running = [.. projects.Select(project => new DrainRunningCard { Project = project, CardId = "0001" })],
        Held = 3,
        PlanDrafts = 0,
        SafeToRestart = false,
    };

    private static MenuBarReading Reading(params MenuBarProjectReading[] projects) => new(projects);

    [Theory]
    [InlineData(0, "0")]
    [InlineData(999, "999")]
    [InlineData(1000, "1K")]
    [InlineData(12_340, "12.3K")]
    [InlineData(999_960, "1M")]
    [InlineData(1_234_567, "1.2M")]
    [InlineData(2_500_000_000, "2.5B")]
    public void Compact_shortens_at_each_thousand(long value, string expected) =>
        Assert.Equal(expected, MenuBarStats.Compact(value));

    [Fact]
    public void A_percentage_of_nothing_is_absent()
    {
        Assert.Null(MenuBarStats.PercentOf(0, 0));
        Assert.Equal(33, MenuBarStats.PercentOf(1, 3));
    }

    [Fact]
    public void Days_add_up_across_projects_in_date_order_with_a_share_of_the_tallest()
    {
        var figures = MenuBarStats.Figures(
            Reading(
                Project("a", days: [Day("2026-11-04", output: 100), Day("2026-11-05", output: 50, input: 7, attempts: 2, failed: 1)]),
                Project("b", days: [Day("2026-11-04", output: 100), Day("2026-11-05", output: 50, input: 3, attempts: 1)])),
            Now);

        Assert.Equal(["2026-11-04", "2026-11-05"], figures.Days.Select(day => day.Date));
        Assert.Equal([1d, 0.5d], figures.Days.Select(day => day.Share));
        Assert.Equal(100, figures.OutputToday);
        Assert.Equal(10, figures.InputToday);
        Assert.Equal(3, figures.AttemptsToday);
        Assert.Equal(1, figures.FailedToday);
    }

    [Fact]
    public void A_quiet_window_has_no_bars_to_divide_by()
    {
        var figures = MenuBarStats.Figures(Reading(Project("a", days: [Day("2026-11-05")])), Now);

        Assert.Equal(0d, Assert.Single(figures.Days).Share);
    }

    [Fact]
    public void A_revise_does_not_count_as_passed()
    {
        var figures = MenuBarStats.Figures(Reading(Project("a", attempts: 10, passed: 8, revised: 3)), Now);

        Assert.Equal(50, figures.PassedPercent);
    }

    [Fact]
    public void Revisions_read_after_the_passes_cannot_go_below_nothing() =>
        Assert.Equal(0, MenuBarStats.PassedOutright(1, 2));

    [Fact]
    public void Shares_are_absent_when_nothing_ran()
    {
        var figures = MenuBarStats.Figures(Reading(Project("a")), Now);

        Assert.Null(figures.PassedPercent);
        Assert.Null(figures.CachedPercent);
    }

    [Fact]
    public void Cached_is_a_share_of_all_input_across_projects()
    {
        var figures = MenuBarStats.Figures(Reading(Project("a", input: 100, cached: 90), Project("b", input: 100, cached: 10)), Now);

        Assert.Equal(50, figures.CachedPercent);
    }

    [Fact]
    public void Capacity_counts_this_machine_and_hosts_still_taking_work()
    {
        var figures = MenuBarStats.Figures(
            new MenuBarReading(
                [],
                Drain("a"),
                [Host("on", 4), Host("off", 8, enabled: false), Host("leaving", 8, draining: true)],
                new LocalStageSlots { Slots = 1 }),
            Now);

        Assert.Equal(5, figures.Capacity);
        Assert.Equal(1, figures.Running);
        Assert.Equal(20, figures.SlotsPercent);
    }

    [Fact]
    public void More_running_than_slots_fills_the_ring_and_no_further()
    {
        var figures = MenuBarStats.Figures(new MenuBarReading([], Drain("a", "a", "a"), [Host("on", 1)], new LocalStageSlots { Slots = 0 }), Now);

        Assert.Equal(3, figures.Running);
        Assert.Equal(100, figures.SlotsPercent);
    }

    [Fact]
    public void No_slots_at_all_shows_an_empty_ring()
    {
        var figures = MenuBarStats.Figures(new MenuBarReading([], Drain(), [], new LocalStageSlots { Slots = 0 }), Now);

        Assert.Equal(0, figures.SlotsPercent);
    }

    [Fact]
    public void What_the_key_may_not_read_is_absent_rather_than_zero()
    {
        var figures = MenuBarStats.Figures(Reading(), Now);

        Assert.Null(figures.Running);
        Assert.Null(figures.Capacity);
        Assert.Null(figures.Held);
        Assert.Null(figures.SlotsPercent);
        Assert.Empty(figures.Hosts);
    }

    [Fact]
    public void A_line_for_each_project_says_what_it_is_doing_today()
    {
        var figures = MenuBarStats.Figures(
            new MenuBarReading(
                [Project("a", days: [Day("2026-11-04", output: 9), Day("2026-11-05", output: 5)], flagged: 2), Project("b")],
                Drain("a", "a", "c")),
            Now);

        Assert.Equal(new MenuBarProjectLine("a", 2, 2, 5), figures.Projects[0]);
        Assert.Equal(new MenuBarProjectLine("b", 0, 0, 0), figures.Projects[1]);
        Assert.Equal(2, figures.NeedsHuman);
    }

    [Fact]
    public void A_host_line_reads_its_slots_and_state()
    {
        var figures = MenuBarStats.Figures(new MenuBarReading([], Hosts: [Host("my-mac", 4, draining: true, running: 1)]), Now);

        Assert.Equal(new MenuBarHostLine("my-mac", 1, 4, "draining"), Assert.Single(figures.Hosts));
    }

    [Fact]
    public void Limits_that_have_reset_are_gone_and_the_soonest_comes_first()
    {
        EngineLimit Limit(string account, int minutes) => new() { Account = account, LimitType = "five_hour", ResetsAt = Now.AddMinutes(minutes) };

        var figures = MenuBarStats.Figures(new MenuBarReading([], Limits: [Limit("later", 120), Limit("past", -1), Limit("soon", 5)]), Now);

        Assert.Equal(["soon", "later"], figures.Limits.Select(limit => limit.Account));
        Assert.Equal("in 5m", figures.Limits[0].Resets);
    }
}
