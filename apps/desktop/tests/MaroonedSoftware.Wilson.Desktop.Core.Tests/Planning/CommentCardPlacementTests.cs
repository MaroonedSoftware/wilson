using MaroonedSoftware.Wilson.Desktop.Core.Planning;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class CommentCardPlacementTests
{
    [Fact]
    public void ItSitsJustUnderThePassage() =>
        Assert.Equal((40d, 20 + CommentCardPlacement.Gap), CommentCardPlacement.Place(40, 20, 500, 280));

    [Fact]
    public void ItStopsAtTheRightEdge() =>
        Assert.Equal(220d, CommentCardPlacement.Place(400, 20, 500, 280).Left);

    [Fact]
    public void ANarrowDraftKeepsItsStartOnScreen() =>
        Assert.Equal(0d, CommentCardPlacement.Place(100, 20, 200, 280).Left);
}
