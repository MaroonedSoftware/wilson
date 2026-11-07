using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class BoardRulesTests
{
    private static CardSummary Card(string id, string stage, bool flagged = false, long? position = null) =>
        new() { Id = id, Title = id, Stage = stage, DependsOn = [], NeedsHuman = flagged, Position = position };

    [Fact]
    public void ColumnsRunParkingLotStagesTerminals_AndAnUnnamedStageIsNeverLost()
    {
        var columns = new BoardColumns { Stages = ["plan", "build"], NonStages = ["parking-lot", "merged"] };

        Assert.Equal(["parking-lot", "plan", "build", "merged", "retired"], BoardRules.ColumnOrder(columns, [Card("1", "retired"), Card("2", "plan")]));
    }

    [Theory]
    [InlineData("parking-lot", false, CardFace.Parked)]
    [InlineData("poisoned", false, CardFace.Poisoned)]
    [InlineData("merged", false, CardFace.Passed)]
    [InlineData("merged", true, CardFace.NeedsHuman)]
    [InlineData("implementing", false, null)]
    public void AFaceSaysOnlyWhatTheRecordSays(string stage, bool flagged, CardFace? face) =>
        Assert.Equal(face, BoardRules.Face(Card("1", stage, flagged)));

    [Fact]
    public void CollapsingFlipsOneStage()
    {
        var collapsed = BoardRules.ToggleCollapsed(["gone", "plan"], "build");

        Assert.Equal(["gone", "plan", "build"], collapsed);
        Assert.Equal(["gone", "build"], BoardRules.ToggleCollapsed(collapsed, "plan"));
    }

    [Fact]
    public void FlaggedCardsLead() =>
        Assert.Equal(["2", "1", "3"], BoardRules.Sorted("build", [Card("3", "build"), Card("1", "build"), Card("2", "build", flagged: true)]).Select(card => card.Id));

    [Fact]
    public void TheParkingLotKeepsTheOperatorsOrder() =>
        Assert.Equal(["2", "1", "3"], BoardRules.Sorted(BoardRules.ParkingLot, [Card("3", "parking-lot"), Card("1", "parking-lot", position: 9), Card("2", "parking-lot", flagged: false, position: 1)]).Select(card => card.Id));

    [Theory]
    [InlineData("", true)]
    [InlineData("  ", true)]
    [InlineData("0012", true)]
    [InlineData(" fix THE ", true)]
    [InlineData("other", false)]
    public void TheFilterReadsIdAndTitleInAnyCase(string filter, bool expected) =>
        Assert.Equal(expected, BoardRules.Matches(Card("0012", "plan") with { Title = "Fix the header" }, filter));

    [Fact]
    public void TheCountNamesTheWholeOnlyWhileFiltering()
    {
        Assert.Equal("7 cards", BoardRules.CountLabel(7, 7, false));
        Assert.Equal("2 of 7 cards", BoardRules.CountLabel(2, 7, true));
    }

    [Fact]
    public void ASplitCountsItsMergedPieces()
    {
        var origin = Card("1", "split");
        CardSummary[] cards = [origin, Card("2", "merged") with { SplitFrom = "1" }, Card("3", "build") with { SplitFrom = "1" }];

        Assert.Equal(new SplitProgress(1, 2), BoardRules.Split(origin, cards));
        Assert.Null(BoardRules.Split(cards[1], cards));
    }

    [Fact]
    public void ADependencyIsUnfinishedUntilMerged_AndAMissingOneNeverReadsAsFine()
    {
        var card = Card("1", "plan") with { DependsOn = ["2", "3", "gone"] };

        Assert.Equal(["3", "gone"], BoardRules.UnfinishedDeps(card, [card, Card("2", "merged"), Card("3", "build")]));
    }

    [Fact]
    public void ASplitOriginIsFinishedWhenEveryPieceIs()
    {
        var card = Card("1", "plan") with { DependsOn = ["2"] };
        var origin = Card("2", "split");
        var piece = Card("3", "merged") with { SplitFrom = "2" };

        Assert.Empty(BoardRules.UnfinishedDeps(card, [card, origin, piece]));
        Assert.Equal(["2"], BoardRules.UnfinishedDeps(card, [card, origin, piece with { Stage = "build" }]));
    }

    [Theory]
    [InlineData("""{"message":"tool.executed"}""", true)]
    [InlineData("""{"message":"tool.denied"}""", true)]
    [InlineData("""{"message":"tool.unguarded"}""", true)]
    [InlineData("""{"message":"tool.anything-later"}""", false)]
    [InlineData("""{"message":"stage.finished"}""", false)]
    [InlineData("not json", false)]
    public void ToolEventsAreRecognised(string data, bool expected) => Assert.Equal(expected, BoardRules.IsToolEvent(data));

    [Theory]
    [InlineData("stage.dispatched", "build", "build", true)]
    [InlineData("tool.executed", "build", "build", true)]
    [InlineData("tool.executed", "test", "build", false)]
    [InlineData("stage.passed", "build", "build", false)]
    public void ALastEventShowsOnlyForTheStageTheCardIsIn(string type, string eventStage, string cardStage, bool expected) =>
        Assert.Equal(expected, BoardRules.ShowsLastEvent(new CardActivity(type, eventStage, default, DateTimeOffset.UnixEpoch), cardStage));

    [Fact]
    public void NoEventMeansNoLastEventLine() => Assert.False(BoardRules.ShowsLastEvent(null, "build"));

    [Theory]
    [InlineData(0, "0s ago")]
    [InlineData(20, "20s ago")]
    [InlineData(90, "2m ago")]
    [InlineData(7200, "2h ago")]
    [InlineData(172800, "2d ago")]
    [InlineData(-5, "0s ago")]
    public void EventAgeRoundsAsTheWebBoardDoes(int seconds, string expected) =>
        Assert.Equal(expected, BoardRules.EventAge(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddSeconds(seconds)));

    [Theory]
    [InlineData(30, "1m in stage")]
    [InlineData(7200, "2h in stage")]
    [InlineData(259200, "3d in stage")]
    public void AgeInStageRoundsAsTheWebBoardDoes(int seconds, string expected) =>
        Assert.Equal(expected, BoardRules.AgeInStage(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddSeconds(seconds)));

    [Fact]
    public void ADropOnAnotherColumnIsAMove() =>
        Assert.Equal(new BoardDrop.Move("build"), BoardRules.Drop("1", "build", ["plan", "build"], [Card("1", "plan")]));

    [Fact]
    public void ADropOnACardMeansItsColumn() =>
        Assert.Equal(new BoardDrop.Move("build"), BoardRules.Drop("1", "2", ["plan", "build"], [Card("1", "plan"), Card("2", "build")]));

    [Theory]
    [InlineData("plan")]
    [InlineData("3")]
    [InlineData("nowhere")]
    [InlineData(null)]
    public void ADropOnItsOwnColumnOrNothingStays(string? over) =>
        Assert.Equal(new BoardDrop.Stay(), BoardRules.Drop("1", over, ["plan", "build"], [Card("1", "plan"), Card("3", "plan")]));

    private static readonly CardSummary[] Lot =
    [
        Card("a", "parking-lot", position: 1),
        Card("b", "parking-lot", position: 2),
        Card("c", "parking-lot", position: 3),
        Card("d", "parking-lot", position: 4),
    ];

    private static readonly string[] Order = ["parking-lot", "plan"];

    private static BoardDrop.Reorder Reorder(string card, string over) => Assert.IsType<BoardDrop.Reorder>(BoardRules.Drop(card, over, Order, Lot));

    [Fact]
    public void DroppingUpTheParkingLotTakesThatCardsPlace()
    {
        var drop = Reorder("c", "a");

        Assert.Equal((null, "a"), (drop.BeforeId, drop.AfterId));
        Assert.Equal(["c", "a", "b", "d"], drop.Order);
    }

    [Fact]
    public void DroppingDownTheParkingLotTakesThatCardsPlace()
    {
        var drop = Reorder("a", "c");

        Assert.Equal(("c", "d"), (drop.BeforeId, drop.AfterId));
        Assert.Equal(["b", "c", "a", "d"], drop.Order);
    }

    [Fact]
    public void DroppingOnTheParkingLotItselfGoesToTheBottom()
    {
        var drop = Reorder("b", "parking-lot");

        Assert.Equal(("d", null), (drop.BeforeId, drop.AfterId));
        Assert.Equal(["a", "c", "d", "b"], drop.Order);
    }

    [Theory]
    [InlineData("b", "b")]
    [InlineData("d", "parking-lot")]
    public void AParkedCardLeftInPlaceStays(string card, string over) =>
        Assert.Equal(new BoardDrop.Stay(), BoardRules.Drop(card, over, Order, Lot));

    [Fact]
    public void ACardComingFromAnotherColumnIsAMoveNeverAReorder() =>
        Assert.Equal(new BoardDrop.Move("parking-lot"), BoardRules.Drop("x", "b", Order, [.. Lot, Card("x", "plan")]));

    [Fact]
    public void AParkedCardLeavingIsAMove() =>
        Assert.Equal(new BoardDrop.Move("plan"), BoardRules.Drop("a", "plan", Order, Lot));

    [Fact]
    public void AFeedEventNamesItsCard()
    {
        Assert.Equal("0123", BoardRules.FeedCardId("""{"correlationId":"0123"}"""));
        Assert.Null(BoardRules.FeedCardId("[]"));
    }

    [Theory]
    [InlineData(CardSummaryDoneReason.Poisoned, CardFace.Poisoned)]
    [InlineData(CardSummaryDoneReason.Merged, CardFace.Passed)]
    public void ADoneCardWearsItsReason(CardSummaryDoneReason reason, CardFace face)
    {
        var card = Card("1", "done") with { DoneReason = reason };

        Assert.Equal(face, BoardRules.Face(card));
        Assert.Equal(reason.ToString().ToLowerInvariant(), BoardRules.Ended(card));
    }

    [Fact]
    public void ADependencyDoneWithAMergedReasonIsFinished()
    {
        var dep = Card("2", "done") with { DoneReason = CardSummaryDoneReason.Merged };
        var card = Card("1", "implementing") with { DependsOn = ["2"] };

        Assert.Empty(BoardRules.UnfinishedDeps(card, [card, dep]));
    }

    private static MergeStatus Merge(MergeStatusState state, string[]? conflicts = null, string[]? moved = null, string? reason = null) =>
        new() { State = state, Target = "main", Conflicts = [.. conflicts ?? []], MovedUnder = [.. moved ?? []], Reason = reason };

    [Fact]
    public void AMergeStatusNamesWhatItWouldHit()
    {
        Assert.Null(BoardRules.MergeStatusLine(null));
        Assert.Equal("Merges cleanly into main.", BoardRules.MergeStatusLine(Merge(MergeStatusState.Clean)));
        Assert.Equal("Conflicts with main: a, b", BoardRules.MergeStatusLine(Merge(MergeStatusState.Conflict, ["a", "b"])));
        Assert.Equal("Conflicts with main.", BoardRules.MergeStatusLine(Merge(MergeStatusState.Conflict)));
        Assert.Equal("Merge would send this back to review: main moved under a.", BoardRules.MergeStatusLine(Merge(MergeStatusState.Rereview, moved: ["a"])));
        Assert.Equal(
            "Merge would send this back to review: main moved under a. It also conflicts: a",
            BoardRules.MergeStatusLine(Merge(MergeStatusState.Rereview, ["a"], ["a"])));
        Assert.Equal(
            "Merge would stop and flag this for a human: main moved under a, and it has used up its re-reviews.",
            BoardRules.MergeStatusLine(Merge(MergeStatusState.Capped, moved: ["a"])));
        Assert.Equal("Could not check the merge: gone", BoardRules.MergeStatusLine(Merge(MergeStatusState.Unknown, reason: "gone")));
    }

    [Theory]
    [InlineData(MergeStatusState.Clean, false)]
    [InlineData(MergeStatusState.Unknown, false)]
    [InlineData(MergeStatusState.Conflict, true)]
    [InlineData(MergeStatusState.Rereview, true)]
    [InlineData(MergeStatusState.Capped, true)]
    public void OnlyAMergeThatWouldNotLandWarns(MergeStatusState state, bool warns) =>
        Assert.Equal(warns, BoardRules.MergeStatusWarns(Merge(state)));

    [Fact]
    public void APlanCheckSaysWhereItHasGot()
    {
        Assert.Null(BoardRules.PlanCheck(null, null));
        Assert.Equal("Checking the plan's scope", BoardRules.PlanCheck(CardSummaryPlanCheck.Checking, null));
        Assert.Equal("Scope check refused: too broad", BoardRules.PlanCheck(CardSummaryPlanCheck.Refused, "too broad"));
    }

    [Theory]
    [InlineData(CardPullRequestState.Open, "PR #7 open")]
    [InlineData(CardPullRequestState.Merged, "PR #7 merged")]
    [InlineData(CardPullRequestState.Closed, null)]
    public void APullRequestTakesMergesPlace_UntilItIsClosed(CardPullRequestState state, string? label) =>
        Assert.Equal(label, BoardRules.PullRequestLabel(new CardPullRequest { Number = 7, Url = "https://github.com/o/r/pull/7", State = state }));

    [Fact]
    public void NoPullRequestMeansMerge() => Assert.Null(BoardRules.PullRequestLabel(null));
}
