using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Board;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class CardFeedTests
{
    private static string Wire(long id, string type, string card = "0001", string payload = """{"tool":"bash"}""") =>
        "{\"id\":" + id + ",\"ts\":\"2026-11-02T10:00:00.000Z\",\"message\":\"" + type + "\",\"correlationId\":\"" + card + "\",\"data\":{\"stage\":\"build\",\"payload\":" + payload + "}}";

    [Fact]
    public void ReadsTheWireShape()
    {
        var read = FeedEvent.Parse(Wire(7, "tool.executed", payload: """{"tool":"bash","command":"ls"}"""))!;

        Assert.Equal(7, read.Id);
        Assert.Equal("tool.executed", read.Type);
        Assert.Equal("0001", read.CardId);
        Assert.Equal("build", read.Stage);
        Assert.Equal("ls", read.Payload.GetProperty("command").GetString());
        Assert.Equal(new DateTimeOffset(2026, 11, 2, 10, 0, 0, TimeSpan.Zero), read.Ts);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"message":"tool.executed"}""")]
    public void AnEventOffTheShapeIsNone(string data) => Assert.Null(FeedEvent.Parse(data));

    [Fact]
    public void AnEventWithNoDataStillParses()
    {
        var read = FeedEvent.Parse("""{"id":1,"ts":"2026-11-02T10:00:00Z","message":"stage.passed","correlationId":"0001"}""")!;

        Assert.Null(read.Stage);
        Assert.Equal(JsonValueKind.Undefined, read.Payload.ValueKind);
    }

    [Fact]
    public void TheLatestEventPerCardIsKept_AndOnlyToolsGoInTheToolList()
    {
        var log = new CardFeedLog();
        log.Record(FeedEvent.Parse(Wire(1, "tool.executed"))!);
        log.Record(FeedEvent.Parse(Wire(2, "stage.passed"))!);
        log.Record(FeedEvent.Parse(Wire(3, "tool.denied", "0002"))!);

        Assert.Equal("stage.passed", log.Activity("0001")!.Type);
        Assert.Equal([1L], log.Tools("0001").Select(tool => tool.Id));
        Assert.Empty(log.Tools("0003"));
    }

    [Fact]
    public void ToolsRunNewestFirst_AndTheListIsBounded()
    {
        var log = new CardFeedLog();
        for (var id = 1; id <= CardFeedLog.MostToolEvents + 5; id++)
        {
            log.Record(FeedEvent.Parse(Wire(id, "tool.executed"))!);
        }

        Assert.Equal(CardFeedLog.MostToolEvents, log.Tools("0001").Count);
        Assert.Equal(CardFeedLog.MostToolEvents + 5, log.Tools("0001")[0].Id);
    }

    [Fact]
    public void AnEventForNoCardIsNotKept()
    {
        var log = new CardFeedLog();
        log.Record(new FeedEvent(1, DateTimeOffset.UnixEpoch, "tool.executed", null, null, default));

        log.Clear();
        Assert.Null(log.Activity("0001"));
    }
}
