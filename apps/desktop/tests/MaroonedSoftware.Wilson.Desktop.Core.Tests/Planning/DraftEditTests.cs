using MaroonedSoftware.Wilson.Desktop.Core.Planning;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class DraftEditTests
{
    [Fact]
    public void CleanTextFollowsTheServer()
    {
        var edit = DraftEdit.Empty.Receive("one").Receive("two");

        Assert.Equal("two", edit.Text);
        Assert.False(edit.Dirty);
    }

    [Fact]
    public void AnEditIsNeverOverwritten_AndTheCollisionIsSaid()
    {
        var edit = DraftEdit.Empty.Receive("one").Typed("mine").Receive("theirs");

        Assert.Equal("mine", edit.Text);
        Assert.True(edit.Collision);
    }

    [Fact]
    public void TheSameDraftArrivingIsNoCollision() =>
        Assert.False(DraftEdit.Empty.Receive("one").Typed("mine").Receive("one").Collision);

    [Fact]
    public void TakingTheIncomingDraftDropsTheEdit()
    {
        var edit = DraftEdit.Empty.Receive("one").Typed("mine").Receive("theirs").UseIncoming();

        Assert.Equal("theirs", edit.Text);
        Assert.False(edit.Dirty);
    }

    [Fact]
    public void ASavedDraftIsWhatTheNextReadShouldFind()
    {
        var edit = DraftEdit.Empty.Receive("one").Typed("mine").Saved();

        Assert.False(edit.Dirty);
        Assert.False(edit.Receive("mine").Collision);
    }

    [Theory]
    [InlineData("new", "old", true)]
    [InlineData("old", "old", false)]
    [InlineData("  ", "old", false)]
    public void ApprovalNeedsAChange(string text, string body, bool can) =>
        Assert.Equal(can, DraftEdit.Empty.Receive("x").Typed(text).CanApprove(body));

    [Fact]
    public void NothingLoadedCannotBeApproved() => Assert.False(DraftEdit.Empty.Typed("new").CanApprove("old"));
}
