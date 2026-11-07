using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class MergeOutcomeTests
{
    private static MergeResult Result(bool merged, string? commit = null, string? reason = null, CardPullRequest? pullRequest = null) =>
        new() { Id = "1", Title = "t", Stage = "s", DependsOn = [], NeedsHuman = false, Body = string.Empty, Sections = [], Merged = merged, Commit = commit, Reason = reason, PullRequest = pullRequest };

    private static CardPullRequest PullRequest(CardPullRequestState state) => new() { Number = 42, Url = "https://github.com/o/r/pull/42", State = state };

    [Fact]
    public async Task ALandedMergeNamesItsCommit()
    {
        var outcome = await MergeOutcome.OfAsync(() => Task.FromResult(Result(true, "abcdef0123456789")));

        Assert.Equal("Landed on main as abcdef01.", outcome.Message);
    }

    [Fact]
    public async Task ARefusalIsTheServersReason()
    {
        var outcome = await MergeOutcome.OfAsync(() => Task.FromResult(Result(false, reason: "The suite failed.")));

        Assert.Equal("The suite failed.", outcome.Message);
    }

    [Fact]
    public async Task OpeningAPullRequestIsNotARefusal()
    {
        var outcome = await MergeOutcome.OfAsync(() => Task.FromResult(Result(false, reason: "opened pull request #42", pullRequest: PullRequest(CardPullRequestState.Open))));

        Assert.Equal(new MergeOutcome.OpenedPullRequest(42), outcome);
        Assert.StartsWith("Opened pull request #42.", outcome.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AClosedPullRequestLeavesTheRefusalStanding() =>
        Assert.IsType<MergeOutcome.Refused>(await MergeOutcome.OfAsync(() => Task.FromResult(Result(false, reason: "No.", pullRequest: PullRequest(CardPullRequestState.Closed)))));

    [Fact]
    public async Task AnErrorStatusIsAnAnswer_SoItIsARefusal() =>
        Assert.IsType<MergeOutcome.Refused>(await MergeOutcome.OfAsync(() => throw new SdkException(409, """{"details":{"reason":"No."}}""")));

    [Fact]
    public async Task ALostConnectionIsUnknown_NeverARefusal() =>
        Assert.IsType<MergeOutcome.Unknown>(await MergeOutcome.OfAsync(() => throw new HttpRequestException("reset")));
}
