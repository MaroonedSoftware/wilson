using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Net;

public class SseReaderTests
{
    [Fact]
    public void DataLinesJoinAndABlankLineDispatches()
    {
        var reader = new SseReader();

        Assert.Null(reader.Line("event: delta"));
        Assert.Null(reader.Line("id: 7"));
        Assert.Null(reader.Line("data: one"));
        Assert.Null(reader.Line("data: two"));

        Assert.Equal(new SseEvent("delta", "one\ntwo", "7"), reader.Line(string.Empty));
    }

    [Fact]
    public void CommentsAndEmptyDispatchesSayNothing()
    {
        var reader = new SseReader();

        Assert.Null(reader.Line(": keep-alive"));
        Assert.Null(reader.Line(string.Empty));
    }

    [Fact]
    public void AnUnnamedEventIsAMessage_AndTheIdOutlivesIt()
    {
        var reader = new SseReader();
        reader.Line("id: 3");
        reader.Line("data:x");

        Assert.Equal("message", reader.Line(string.Empty)!.Event);

        reader.Line("data: y");
        Assert.Equal("3", reader.Line(string.Empty)!.Id);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(3, 8)]
    [InlineData(5, 30)]
    [InlineData(40, 30)]
    public void ReconnectingBacksOff(int attempt, int seconds) => Assert.Equal(seconds, StreamSignal.ReconnectDelay(attempt).TotalSeconds);
}
