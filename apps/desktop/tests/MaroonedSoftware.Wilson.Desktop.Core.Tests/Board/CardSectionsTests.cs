using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Board;

public class CardSectionsTests
{
    private static CardEvent Event(string type, string? stage = null, string payload = "{}") =>
        new() { Id = Guid.NewGuid().ToString(), Type = type, Stage = stage, Payload = JsonDocument.Parse(payload).RootElement, CreatedAt = DateTimeOffset.UnixEpoch };

    [Fact]
    public void BulletsLoseTheirMarkersAndBackticks() =>
        Assert.Equal(["apps/web/**", "apps/api/x.ts"], CardSections.FilesInScope("- `apps/web/**`\n* apps/api/x.ts\n<!-- none -->\n"));

    [Fact]
    public void ALineWithNoMarkerContinuesTheBullet_AndABlankLineEndsIt() =>
        Assert.Equal(["one wrapped", "two", "three"], CardSections.FilesInScope("- one\n  wrapped\n- two\n\nthree"));

    [Fact]
    public void WithNoMarkersEachLineIsAnItem() =>
        Assert.Equal(["a", "b"], CardSections.FilesInScope("a\n\n`b`\n<!-- c -->"));

    [Fact]
    public void NoSectionIsNoItems()
    {
        Assert.Empty(CardSections.FilesInScope(null));
        Assert.Empty(CardSections.AcceptanceCriteria(string.Empty));
    }

    [Fact]
    public void ACriterionKeepsItsIdOrGetsItsPlace() =>
        Assert.Equal(
            [new Criterion("AC7", "first"), new Criterion("AC2", "no id: second"), new Criterion("AC3", "third"), new Criterion("AC4", "fourth")],
            CardSections.AcceptanceCriteria("- AC7: first\n- no id: second\n- AC-3. third\n- AC4:   fourth"));

    [Fact]
    public void ANumberedListIsOneCriterionPerNumber() =>
        Assert.Equal(
            [new Criterion("AC1", "first wrapped"), new Criterion("AC2", "second"), new Criterion("AC3", "tenth")],
            CardSections.AcceptanceCriteria("1. first\n   wrapped\n2. second\n10) tenth"));

    [Fact]
    public void StatusesComeFromTheLatestReview()
    {
        var statuses = CardSections.ReviewStatuses(
        [
            Event("stage.failed", "review", """{"result":{"criteria":[{"id":"AC1","status":"unmet"}]}}"""),
            Event("stage.passed", "implementing", """{"result":{"criteria":[{"id":"AC1","status":"unmet"}]}}"""),
            Event("stage.passed", "review", """{"result":{"criteria":[{"id":"AC1","status":"met"},{"id":"AC2","status":"bogus"},{"id":3,"status":"met"}]}}"""),
        ]);

        Assert.Equal("met", Assert.Single(statuses).Value);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"result":{}}""")]
    [InlineData("""{"result":{"criteria":"none"}}""")]
    public void AReviewWithNoCriteriaSaysNothing(string payload) =>
        Assert.Empty(CardSections.ReviewStatuses([Event("stage.passed", "review", payload)]));

    [Fact]
    public void TheHostIsTheLastDispatchsPlacement()
    {
        var placed = Event("stage.placed", null, """{"host":"tower"}""");

        Assert.Equal("tower", CardSections.LastStageHost([placed, Event("stage.dispatched")]));
        Assert.Null(CardSections.LastStageHost([placed, Event("stage.dispatched"), Event("stage.dispatched")]));
        Assert.Null(CardSections.LastStageHost([placed]));
    }

    [Fact]
    public void AnEventsDetailIsOnlyForTheOnesThatHaveOne()
    {
        Assert.Equal("full", CardSections.EventDetail(Event("dispatch.deferred", null, """{"reason":"full"}""")));
        Assert.Equal("on tower", CardSections.EventDetail(Event("stage.placed", null, """{"host":"tower"}""")));
        Assert.Equal("tower stopped answering: gone", CardSections.EventDetail(Event("stage.host-lost", null, """{"host":"tower","reason":"gone"}""")));
        Assert.Equal("tower stopped answering", CardSections.EventDetail(Event("stage.host-lost", null, """{"host":"tower"}""")));
        Assert.Null(CardSections.EventDetail(Event("stage.passed", null, """{"host":"tower"}""")));
    }
}
