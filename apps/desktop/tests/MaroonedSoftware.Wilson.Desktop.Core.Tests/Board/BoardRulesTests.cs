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
    [InlineData("""{"message":"tool.started"}""", true)]
    [InlineData("""{"message":"stage.finished"}""", false)]
    [InlineData("not json", false)]
    public void ToolEventsAreRecognised(string data, bool expected) => Assert.Equal(expected, BoardRules.IsToolEvent(data));

    [Fact]
    public void AFeedEventNamesItsCard()
    {
        Assert.Equal("0123", BoardRules.FeedCardId("""{"correlationId":"0123"}"""));
        Assert.Null(BoardRules.FeedCardId("[]"));
    }
}
