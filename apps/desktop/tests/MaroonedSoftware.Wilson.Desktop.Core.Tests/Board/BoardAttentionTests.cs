using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class BoardAttentionTests
{
    private static readonly DateTimeOffset Noon = new(2026, 11, 7, 12, 0, 0, TimeSpan.Zero);

    private static CardSummary Card(string id, string stage, bool flagged = false) =>
        new() { Id = id, Title = id, Stage = stage, DependsOn = [], NeedsHuman = flagged };

    private static CardBlocked Asked(DateTimeOffset at) =>
        new() { Category = CardBlockedCategory.Decision, Tried = "read it", Question = "Which?", Stage = "implementing", AskedAt = at };

    private static MergeStatus Merging(MergeStatusState state) =>
        new() { State = state, Conflicts = [], MovedUnder = [] };

    [Fact]
    public void AQuestionOutranksTheFlagItComesWith() =>
        Assert.Equal(Attention.Question, BoardAttention.Of(Card("1", "implementing", flagged: true) with { Blocked = Asked(Noon) }));

    [Fact]
    public void AFlagOutranksTheStage() =>
        Assert.Equal(Attention.Flag, BoardAttention.Of(Card("1", "ready", flagged: true)));

    [Fact]
    public void APlanWaitsUnlessItsScopeIsBeingChecked()
    {
        Assert.Equal(Attention.Plan, BoardAttention.Of(Card("1", "planning")));
        Assert.Equal(Attention.Plan, BoardAttention.Of(Card("1", "planning") with { PlanCheck = CardSummaryPlanCheck.Refused }));
        Assert.Null(BoardAttention.Of(Card("1", "planning") with { PlanCheck = CardSummaryPlanCheck.Checking }));
    }

    [Theory]
    [InlineData(null, Attention.Merge)]
    [InlineData(MergeStatusState.Clean, Attention.Merge)]
    [InlineData(MergeStatusState.Conflict, Attention.Conflict)]
    [InlineData(MergeStatusState.Rereview, Attention.Conflict)]
    [InlineData(MergeStatusState.Capped, Attention.Conflict)]
    [InlineData(MergeStatusState.Unknown, Attention.Conflict)]
    public void AReadyCardWaitsToMergeOnlyWhenNothingSaysItWouldNot(MergeStatusState? state, Attention expected) =>
        Assert.Equal(expected, BoardAttention.Of(Card("1", "ready") with { MergeStatus = state is { } known ? Merging(known) : null }));

    [Fact]
    public void AnOpenPullRequestWaitsOnGitHubNotAPerson() =>
        Assert.Null(BoardAttention.Of(Card("1", "ready") with { PullRequest = new() { Number = 4, Url = "https://x", State = CardPullRequestState.Open } }));

    [Theory]
    [InlineData("implementing")]
    [InlineData("parking-lot")]
    [InlineData("merged")]
    public void OtherCardsWaitOnNobody(string stage) =>
        Assert.Null(BoardAttention.Of(Card("1", stage)));

    [Fact]
    public void FlaggedKeepsQuestionsAsTheHeadersCountDoes()
    {
        var question = Card("1", "implementing", flagged: true) with { Blocked = Asked(Noon) };

        Assert.True(BoardAttention.Shows(BoardNarrowing.Flagged, question));
        Assert.True(BoardAttention.Shows(BoardNarrowing.Questions, question));
        Assert.True(BoardAttention.Shows(BoardNarrowing.NeedsYou, question));
        Assert.False(BoardAttention.Shows(BoardNarrowing.Plans, question));
        Assert.True(BoardAttention.Shows(BoardNarrowing.All, Card("2", "implementing")));
        Assert.False(BoardAttention.Shows(BoardNarrowing.NeedsYou, Card("2", "implementing")));
    }

    [Fact]
    public void WaitingRunsByKindThenLongestWaiting()
    {
        CardSummary[] cards =
        [
            Card("merge", "ready") with { StageEnteredAt = Noon.AddDays(-9) },
            Card("idle", "implementing"),
            Card("plan-new", "planning") with { StageEnteredAt = Noon },
            Card("plan-old", "planning") with { StageEnteredAt = Noon.AddHours(-1) },
            Card("asked", "implementing", flagged: true) with { Blocked = Asked(Noon), StageEnteredAt = Noon.AddDays(-30) },
            Card("flag", "review", flagged: true),
        ];

        Assert.Equal(["asked", "flag", "plan-old", "plan-new", "merge"], BoardAttention.Waiting(cards).Select(card => card.Id));
    }

    [Fact]
    public void EveryChipHasWordsAndOnlyAllSaysNothingWhenEmpty()
    {
        Assert.All(BoardAttention.Narrowings, narrowing => Assert.False(string.IsNullOrEmpty(BoardAttention.Label(narrowing))));
        Assert.Null(BoardAttention.Empty(BoardNarrowing.All));
        Assert.Equal("Nothing is flagged right now.", BoardAttention.Empty(BoardNarrowing.Flagged));
        Assert.Equal("Cards needing a human", BoardAttention.Heading(BoardNarrowing.Flagged));
    }
}
