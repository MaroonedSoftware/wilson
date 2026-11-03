using MaroonedSoftware.Wilson.Desktop.Core.Planning;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class PlanFeedbackTests
{
    [Theory]
    [InlineData(1, "1 comment to send")]
    [InlineData(3, "3 comments to send")]
    public void TheSummaryCounts(int open, string expected) => Assert.Equal(expected, PlanFeedback.Summary(open));

    [Theory]
    [InlineData(1, false, false, true)]
    [InlineData(0, false, false, false)]
    [InlineData(1, true, false, false)]
    [InlineData(1, false, true, false)]
    public void ItSendsOpenCommentsOverACleanDraft_OneTurnAtATime(int open, bool dirty, bool sending, bool expected) =>
        Assert.Equal(expected, PlanFeedback.CanSend(open, dirty, sending));

    [Fact]
    public void AnEditIsSaidToBeInTheWay_OnlyWhenThereIsSomethingToSend()
    {
        Assert.Equal(PlanFeedback.UnsavedEdits, PlanFeedback.Blocked(1, dirty: true));
        Assert.Null(PlanFeedback.Blocked(0, dirty: true));
        Assert.Null(PlanFeedback.Blocked(1, dirty: false));
    }
}
