using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class ToolRowsTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 2, 10, 0, 0, TimeSpan.Zero);

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    private static CardEvent Seed(string id, string type, int seconds, string payload = """{"tool":"bash","command":"seed"}""") =>
        new() { Id = id, Type = type, Stage = "build", Payload = Json(payload), CreatedAt = At.AddSeconds(seconds) };

    private static FeedToolEvent Live(long id, string type, int seconds, string payload = """{"tool":"bash","command":"live"}""") =>
        new(id, type, Json(payload), At.AddSeconds(seconds));

    [Fact]
    public void LiveLeads_ThenTheTailNewestFirst_WithoutAnEventThatIsNoTool()
    {
        var rows = ToolRows.Merge(
            [Seed("1", "tool.executed", 0), Seed("2", "stage.passed", 1), Seed("3", "tool.executed", 2)],
            [Live(9, "tool.executed", 5)]);

        Assert.Equal([At.AddSeconds(5), At.AddSeconds(2), At], rows.Select(row => row.At));
    }

    [Fact]
    public void TheEventConnectingReplaysIsNotShownTwice()
    {
        var rows = ToolRows.Merge([Seed("1", "tool.executed", 2)], [Live(9, "tool.executed", 2)]);

        Assert.Equal("seed", Assert.Single(rows).Label);
    }

    [Fact]
    public void AnotherTypeAtTheSameInstantIsAnotherCall() =>
        Assert.Equal(2, ToolRows.Merge([Seed("1", "tool.executed", 2)], [Live(9, "tool.denied", 2)]).Count);

    [Theory]
    [InlineData("tool.denied", """{"tool":"bash","reason":"not allowed","command":"rm"}""", "bash", "not allowed")]
    [InlineData("tool.executed", """{"tool":"bash","reason":"ignored","command":"ls"}""", "bash", "ls")]
    [InlineData("tool.executed", """{"tool":"write","path":"a.ts"}""", "write", "a.ts")]
    [InlineData("tool.executed", """{}""", "tool", "")]
    [InlineData("tool.executed", """[]""", "tool", "")]
    public void ARowNamesItsToolAndLabel(string type, string payload, string tool, string label)
    {
        var row = Assert.Single(ToolRows.Merge([], [Live(1, type, 0, payload)]));

        Assert.Equal((tool, label), (row.Tool, row.Label));
    }

    [Fact]
    public void TheListIsBounded() =>
        Assert.Equal(CardFeedLog.MostToolEvents, ToolRows.Merge(Enumerable.Range(0, 150).Select(i => Seed($"{i}", "tool.executed", i)), []).Count);
}
