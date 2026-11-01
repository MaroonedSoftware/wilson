using MaroonedSoftware.Wilson.Desktop.Core.Planning;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Planning;

public class PlanTranscriptTests
{
    private static PlanTurn Turn(long seq, PlanTurnRole role, string content) =>
        new() { Seq = seq, Role = role, Content = content, CreatedAt = DateTimeOffset.UnixEpoch };

    [Fact]
    public void ATurnArrivingTwiceShowsOnce_AndInOrder()
    {
        IReadOnlyList<PlanTurn> turns = [Turn(1, PlanTurnRole.User, "a"), Turn(3, PlanTurnRole.User, "c")];

        var folded = PlanTranscript.Insert(PlanTranscript.Insert(turns, Turn(2, PlanTurnRole.Assistant, "b")), Turn(2, PlanTurnRole.Assistant, "b"));

        Assert.Equal([1, 2, 3], folded.Select(turn => turn.Seq));
    }

    [Fact]
    public void AReplyBringsThePersonsOwnTurnWithIt()
    {
        var folded = PlanTranscript.WithReply([], Turn(6, PlanTurnRole.Assistant, "answer"), "question");

        Assert.Equal(["question", "answer"], folded.Select(turn => turn.Content));
        Assert.Equal(PlanTurnRole.User, folded[0].Role);
    }

    [Fact]
    public void ARealTurnAlreadyHeldIsNotReplaced()
    {
        var folded = PlanTranscript.WithReply([Turn(5, PlanTurnRole.User, "the stored one")], Turn(6, PlanTurnRole.Assistant, "answer"), "typed");

        Assert.Equal("the stored one", folded[0].Content);
    }

    [Fact]
    public void AModeWithNoTextAddsNoEmptyTurn() =>
        Assert.Single(PlanTranscript.WithReply([], Turn(6, PlanTurnRole.Assistant, "answer"), "  "));
}
