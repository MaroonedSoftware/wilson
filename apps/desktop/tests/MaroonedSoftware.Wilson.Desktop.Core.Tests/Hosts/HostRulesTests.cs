using MaroonedSoftware.Wilson.Desktop.Core.Hosts;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Hosts;

public sealed class HostRulesTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);

    private static Host Host(bool enabled = true, bool draining = false, HostKind kind = HostKind.Ssh) => new()
    {
        Name = "agent-1",
        Kind = kind,
        SshTarget = kind == HostKind.Ssh ? "agent-1.local" : null,
        Slots = 2,
        Enabled = enabled,
        Draining = draining, Isolated = false,
        CommandEnv = [],
        Projects = [],
        Running = [],
    };

    [Theory]
    [InlineData(0, "in less than a minute")]
    [InlineData(5, "in 5m")]
    [InlineData(-5, "5m ago")]
    [InlineData(192, "in 3h 12m")]
    [InlineData(-61, "1h 1m ago")]
    public void Relative_is_to_the_minute(int minutes, string expected) =>
        Assert.Equal(expected, HostRules.Relative(Now.AddMinutes(minutes), Now));

    [Fact]
    public void Relative_keeps_the_direction_under_a_minute() =>
        Assert.Equal("less than a minute ago", HostRules.Relative(Now.AddSeconds(-5), Now));

    [Fact]
    public void State_names_the_switch_that_stops_it()
    {
        Assert.Equal("enabled", HostRules.State(Host()));
        Assert.Equal("draining", HostRules.State(Host(draining: true)));
        Assert.Equal("disabled", HostRules.State(Host(enabled: false, draining: true)));
    }

    [Fact]
    public void Probe_says_when_and_how_it_went()
    {
        Assert.Equal("never probed", HostRules.Probe(Host(), Now));

        var probed = Host() with { Probe = new HostProbe { ProbedAt = Now.AddMinutes(-5), Ok = false } };
        Assert.Equal("probe failed 5m ago", HostRules.Probe(probed, Now));
    }

    [Fact]
    public void Connection_is_only_a_worker_s_and_says_how_long()
    {
        Assert.Null(HostRules.Connection(Host(), Now));
        Assert.Equal("not connected", HostRules.Connection(Host(kind: HostKind.Worker), Now));

        var connected = Host(kind: HostKind.Worker) with { Connection = new HostConnection { Since = Now.AddMinutes(-192), WorkerVersion = "1.2.3", Platform = "linux" } };
        Assert.Equal("connected 3h 12m ago", HostRules.Connection(connected, Now));
    }

    [Fact]
    public void Summary_of_a_connected_worker_names_its_version_and_platform()
    {
        var connected = Host(kind: HostKind.Worker) with { Connection = new HostConnection { Since = Now, WorkerVersion = "1.2.3", Platform = "linux" } };
        Assert.StartsWith("worker 1.2.3 on linux · ", HostRules.Summary(connected, Now));
    }

    private static HostRun Run(HostRunOutcome outcome, int startedMinutesAgo = 60, int? endedMinutesAgo = null) => new()
    {
        Project = "wilson",
        CardId = "0012",
        Stage = "implementing",
        StartedAt = Now.AddMinutes(-startedMinutesAgo),
        EndedAt = endedMinutesAgo is { } ended ? Now.AddMinutes(-ended) : null,
        Outcome = outcome,
    };

    [Theory]
    [InlineData(HostRunOutcome.Running, "running")]
    [InlineData(HostRunOutcome.Passed, "passed")]
    [InlineData(HostRunOutcome.Failed, "failed")]
    [InlineData(HostRunOutcome.Lost, "host lost")]
    [InlineData(HostRunOutcome.Interrupted, "interrupted")]
    [InlineData(HostRunOutcome.Abandoned, "abandoned")]
    [InlineData(HostRunOutcome.Unknown, "no word")]
    [InlineData(HostRunOutcome.Unknown2, "no word")]
    public void Outcome_is_a_word_or_two(HostRunOutcome outcome, string expected) =>
        Assert.Equal(expected, HostRules.Outcome(Run(outcome)));

    [Fact]
    public void RunDetail_says_how_long_a_run_took_once_it_has_ended()
    {
        Assert.Equal("implementing · 45m, ended 15m ago", HostRules.RunDetail(Run(HostRunOutcome.Passed, 60, 15), Now));
        Assert.Equal("implementing · 1h 30m, ended 30m ago", HostRules.RunDetail(Run(HostRunOutcome.Failed, 120, 30), Now));
        Assert.Equal("implementing · under a minute, ended 5m ago", HostRules.RunDetail(Run(HostRunOutcome.Passed, 5, 5), Now));
    }

    [Fact]
    public void RunDetail_says_when_it_started_while_there_is_no_end() =>
        Assert.Equal("implementing · started 1h 0m ago", HostRules.RunDetail(Run(HostRunOutcome.Running), Now));

    [Fact]
    public void Summary_of_an_ssh_host_names_its_target() =>
        Assert.Equal("ssh agent-1.local", HostRules.Summary(Host(), Now));

    [Fact]
    public void Summary_of_a_worker_says_whether_it_has_a_token()
    {
        Assert.Equal("worker · no token yet", HostRules.Summary(Host(kind: HostKind.Worker), Now));

        var issued = Host(kind: HostKind.Worker) with { WorkerToken = new WorkerTokenSummary { Hint = "ab12", IssuedAt = Now } };
        Assert.Equal("worker · token …ab12", HostRules.Summary(issued, Now));
    }

    [Fact]
    public void Summary_prefers_a_known_expiry_to_the_lifetime()
    {
        var host = Host() with { LifetimeMinutes = 720, CommandEnv = ["GITHUB_TOKEN"] };
        Assert.Equal("ssh agent-1.local · lives 720m after boot · commands get GITHUB_TOKEN from it", HostRules.Summary(host, Now));

        var expiring = host with { Probe = new HostProbe { ProbedAt = Now, Ok = true, EngineVersion = "2.1", ExpiresAt = Now.AddMinutes(90) } };
        Assert.Equal("ssh agent-1.local · claude 2.1 · expires in 1h 30m · commands get GITHUB_TOKEN from it", HostRules.Summary(expiring, Now));
    }

    [Fact]
    public void Slots_counts_what_is_running()
    {
        Assert.Equal("0 of 2 slots in use", HostRules.Slots(Host()));
        Assert.Equal("0 of 1 slot in use", HostRules.Slots(Host() with { Slots = 1 }));
    }

    [Fact]
    public void Registration_leaves_out_what_was_not_filled_in()
    {
        var request = HostRules.Registration(" agent-3 ", worker: false, "  ", null, null, " ");

        Assert.Equal("agent-3", request.Name);
        Assert.Null(request.Kind);
        Assert.Null(request.SshTarget);
        Assert.Null(request.CommandEnv);
    }

    [Fact]
    public void Registration_of_a_worker_has_no_ssh_target_and_splits_the_env()
    {
        var request = HostRules.Registration("w", worker: true, "ignored", 2, 720, "A, B,,");

        Assert.Equal(CreateHostRequestKind.Worker, request.Kind);
        Assert.Null(request.SshTarget);
        Assert.Equal(["A", "B"], request.CommandEnv);
    }
}
