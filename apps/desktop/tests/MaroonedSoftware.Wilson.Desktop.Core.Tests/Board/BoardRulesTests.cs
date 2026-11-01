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
