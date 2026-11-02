using MaroonedSoftware.Wilson.Desktop.Core.Planning;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class DraftDiffTests
{
    [Fact]
    public void OnlyWhatChangedIsListed() =>
        Assert.Equal(
            [new DraftDiffLine(false, "b"), new DraftDiffLine(true, "B"), new DraftDiffLine(true, "d")],
            DraftDiff.Lines("a\nb\nc", "a\nB\nc\nd"));

    [Fact]
    public void TheSameTextHasNoLines() => Assert.Empty(DraftDiff.Lines("a\nb", "a\nb"));
}
