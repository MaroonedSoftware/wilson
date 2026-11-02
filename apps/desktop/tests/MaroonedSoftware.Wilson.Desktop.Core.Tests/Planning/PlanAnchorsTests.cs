using MaroonedSoftware.Wilson.Desktop.Core.Planning;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class PlanAnchorsTests
{
    [Fact]
    public void CaptureKeepsAWindowEachSide()
    {
        var text = new string('a', 70) + "quote" + new string('b', 70);

        var anchor = PlanAnchors.Capture(text, 70, 75);

        Assert.Equal("quote", anchor.Quote);
        Assert.Equal(new string('a', 60), anchor.Prefix);
        Assert.Equal(new string('b', 60), anchor.Suffix);
    }

    [Fact]
    public void AWindowStopsAtTheEnds()
    {
        var anchor = PlanAnchors.Capture("abcdef", 2, 4);

        Assert.Equal(new PlanAnchor("cd", "ab", "ef"), anchor);
    }

    [Fact]
    public void AUniqueQuoteIsFoundWhateverSurroundsItNow() =>
        Assert.Equal(new AnchorRange(4, 9), PlanAnchors.Locate("new quote text", new PlanAnchor("quote", "old ", " words")));

    [Fact]
    public void AGoneQuoteIsOutdated() => Assert.Null(PlanAnchors.Locate("nothing here", new PlanAnchor("quote", string.Empty, string.Empty)));

    [Fact]
    public void AnEmptyQuoteMatchesNothing() => Assert.Null(PlanAnchors.Locate("text", new PlanAnchor(string.Empty, string.Empty, string.Empty)));

    [Fact]
    public void ARepeatedQuoteOnItsPrefixPicksThatOccurrence() =>
        Assert.Equal(new AnchorRange(23, 26), PlanAnchors.Locate("first the thing second the thing", new PlanAnchor("the", "second ", " thing")));

    [Fact]
    public void ATieIsOutdated_NotAGuess() => Assert.Null(PlanAnchors.Locate("x the y the z", new PlanAnchor("the", "no", "ne")));

    [Fact]
    public void OverlappingOccurrencesCount() => Assert.Null(PlanAnchors.Locate("aaa", new PlanAnchor("aa", string.Empty, string.Empty)));
}
