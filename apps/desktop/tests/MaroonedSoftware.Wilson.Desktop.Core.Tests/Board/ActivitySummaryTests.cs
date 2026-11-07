using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Board;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class ActivitySummaryTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    [Fact]
    public void AStageFillsItsSentence() =>
        Assert.Equal(new ActivityLine("Failed review", ActivityTone.Bad), ActivitySummary.Summarize("stage.failed", "review", Json("{}")));

    [Fact]
    public void NoStageStillReads() =>
        Assert.Equal("Started a stage", ActivitySummary.Summarize("stage.dispatched", null, Json("{}")).Label);

    [Fact]
    public void AMoveNamesWhereItWent() =>
        Assert.Equal(new ActivityLine("Moved to ready", ActivityTone.Going), ActivitySummary.Summarize("transition.written", null, Json("""{"from":"review","to":"ready"}""")));

    [Theory]
    [InlineData("""{"from":"review","to":"review"}""")]
    [InlineData("{}")]
    public void AWriteThatStaysPutOnlyUpdated(string payload) =>
        Assert.Equal("Updated the card", ActivitySummary.Summarize("transition.written", null, Json(payload)).Label);

    [Theory]
    [InlineData("card.pull-request-opened", "Opened a pull request")]
    [InlineData("card.pull-request-closed", "Pull request closed without merging")]
    public void APullRequestsEventsRead(string type, string label) =>
        Assert.Equal(label, ActivitySummary.Summarize(type, null, Json("{}")).Label);

    [Fact]
    public void AnUnknownTypeShowsAsRecorded() =>
        Assert.Equal(new ActivityLine("card.future", ActivityTone.Quiet), ActivitySummary.Summarize("card.future", null, Json("null")));

    [Fact]
    public void AReasonIsOnlyAString()
    {
        Assert.Equal("full", ActivitySummary.Reason(Json("""{"reason":"full"}""")));
        Assert.Null(ActivitySummary.Reason(Json("""{"reason":1}""")));
        Assert.Null(ActivitySummary.Reason(Json("""{"reason":""}""")));
    }
}
