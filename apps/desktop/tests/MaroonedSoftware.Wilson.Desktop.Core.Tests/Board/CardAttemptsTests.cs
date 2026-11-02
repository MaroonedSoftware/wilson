using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class CardAttemptsTests
{
    private static CardEvent Event(string type, string? stage = "review", string payload = "{}") =>
        new() { Id = Guid.NewGuid().ToString(), Type = type, Stage = stage, Payload = JsonDocument.Parse(payload).RootElement, CreatedAt = DateTimeOffset.UnixEpoch };

    [Fact]
    public void AttemptsReadNewestFirst_AndARunReplacedWithNoEndingWasInterrupted()
    {
        var attempts = CardAttempts.Group([Event("stage.dispatched", "implementing"), Event("tool.executed"), Event("stage.dispatched", "review")]);

        Assert.Equal(["review", "implementing"], attempts.Select(attempt => attempt.Stage));
        Assert.Equal(["running", "interrupted"], attempts.Select(attempt => attempt.Outcome));
        Assert.Equal(1, attempts[1].ToolCalls);
    }

    [Fact]
    public void EventsBeforeTheFirstDispatchAreATailAndDropped() =>
        Assert.Empty(CardAttempts.Group([Event("tool.executed"), Event("stage.passed")]));

    [Fact]
    public void EventsAfterAnEndingCountForNothing()
    {
        var attempt = Assert.Single(CardAttempts.Group([Event("stage.dispatched"), Event("stage.passed"), Event("tool.executed")]));

        Assert.Equal("passed", attempt.Outcome);
        Assert.Equal(0, attempt.ToolCalls);
    }

    [Fact]
    public void AnEndingCarriesWhatTheRunReported()
    {
        var attempt = Assert.Single(CardAttempts.Group(
        [
            Event("stage.dispatched"),
            Event("tool.executed"),
            Event("tool.denied"),
            Event("stage.failed", payload: """{"usage":{"inputTokens":100,"cachedInputTokens":20,"outputTokens":30},"trace":{"reads":2,"readPaths":["a.ts",4],"finalMessage":"Done"},"failures":["AC2 unmet"]}"""),
        ]));

        Assert.Equal("failed", attempt.Outcome);
        Assert.Equal(120, attempt.InputTokens);
        Assert.Equal(30, attempt.OutputTokens);
        Assert.Equal(["a.ts"], attempt.ReadPaths);
        Assert.Equal("Done", attempt.FinalMessage);
        Assert.Equal(["AC2 unmet"], attempt.Failures);
        Assert.Equal("120 input tokens · 1 tool calls · 1 refused · 2 reads", attempt.Tally);
    }

    [Fact]
    public void AnAttemptFromBeforeTracesHasNoReads()
    {
        var attempt = Assert.Single(CardAttempts.Group([Event("stage.dispatched"), Event("stage.dead")]));

        Assert.Equal("dead", attempt.Outcome);
        Assert.Null(attempt.Reads);
        Assert.Equal("0 tool calls", attempt.Tally);
    }
}
