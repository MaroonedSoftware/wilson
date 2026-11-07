using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class ChatRulesTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch.AddYears(50);

    private static ChatMessage Message(ChatMessageRole role, int second, params string[] suggestions) => new()
    {
        Seq = second,
        Role = role,
        Content = "text",
        Operations = [],
        CreatedAt = Now.AddSeconds(second),
        Suggestions = [.. suggestions],
    };

    private static ChatPendingAction Proposed(int second, ChatPendingActionStatus status = ChatPendingActionStatus.Pending) => new()
    {
        Id = "a",
        ThreadId = "t",
        Operation = "op",
        Arguments = JsonSerializer.SerializeToElement(new { }),
        Summary = "s",
        Status = status,
        ExpiresAt = Now.AddHours(1),
        CreatedAt = Now.AddSeconds(second),
    };

    private static ChatThreadDetail Detail(ChatMessage[] messages, params ChatPendingAction[] actions) => new()
    {
        Thread = new ChatThread { Id = "t", Title = "t", Engine = ChatThreadEngine.Api, CreatedAt = Now, UpdatedAt = Now },
        Messages = [.. messages],
        Actions = [.. actions],
        Questions = [],
    };

    private static ChatQuestion Prompt(bool multiSelect = false) => new()
    {
        Header = "Fix",
        Text = "Which fix?",
        Options = [new() { Label = "Reword", Description = "d" }, new() { Label = "Approve", Description = "d" }, new() { Label = "Re-run", Description = "d" }],
        MultiSelect = multiSelect,
    };

    private static ChatPendingQuestion Asked(int second, ChatPendingQuestionStatus status = ChatPendingQuestionStatus.Pending, int expiresIn = 600, List<ChatQuestionAnswer>? answers = null) => new()
    {
        Id = "q",
        ThreadId = "t",
        Questions = [Prompt()],
        Answers = answers,
        Status = status,
        ExpiresAt = Now.AddSeconds(expiresIn),
        CreatedAt = Now.AddSeconds(second),
    };

    private static ChatOperation Ran(string name, string? project, bool ok) => new()
    {
        Name = name,
        Project = project,
        Ok = ok,
        Arguments = JsonSerializer.SerializeToElement(new { id = 1 }),
    };

    [Fact]
    public void AChangeSitsBesideTheAnswerThatProposedIt()
    {
        var steps = ChatRules.Timeline([Message(ChatMessageRole.User, 0), Message(ChatMessageRole.Assistant, 2)], [Proposed(1)]);

        Assert.Equal([false, true, false], steps.Select(step => step.Action is not null));
    }

    [Fact]
    public void AQuestionSitsBesideTheAnswerThatAskedIt()
    {
        var steps = ChatRules.Timeline([Message(ChatMessageRole.User, 0), Message(ChatMessageRole.Assistant, 2)], [], [Asked(1)]);

        Assert.Equal([false, true, false], steps.Select(step => step.Question is not null));
    }

    [Fact]
    public void NoFollowUpsWhileAQuestionWaits()
    {
        var answer = Message(ChatMessageRole.Assistant, 1, "next");
        var waiting = Detail([answer]) with { Questions = [Asked(0)] };
        var lapsed = Detail([answer]) with { Questions = [Asked(0, expiresIn: -1)] };

        Assert.Empty(ChatRules.FollowUps(waiting, false, Now));
        Assert.Equal(["next"], ChatRules.FollowUps(lapsed, false, Now));
    }

    [Theory]
    [InlineData(ChatPendingQuestionStatus.Pending, 60, null)]
    [InlineData(ChatPendingQuestionStatus.Pending, -60, "expired")]
    [InlineData(ChatPendingQuestionStatus.Answered, 60, "answered")]
    [InlineData(ChatPendingQuestionStatus.Dismissed, 60, "dismissed")]
    public void AQuestionSaysHowItWent(ChatPendingQuestionStatus status, int expiresIn, string? expected)
    {
        var question = Asked(0, status, expiresIn);

        Assert.Equal(expected, ChatRules.QuestionOutcome(question, Now));
        Assert.Equal(expected is null, ChatRules.IsUnanswered(question, Now));
    }

    [Fact]
    public void AnAnswerReadsAsItsLabelsThenItsOwnWords()
    {
        Assert.Equal("Reword, Re-run, my way", ChatRules.AnswerText(Prompt(true), new() { Chosen = [0, 2], Other = "my way" }));
        Assert.Equal("Approve", ChatRules.AnswerText(Prompt(), new() { Chosen = [1, 7] }));
        Assert.Null(ChatRules.AnswerText(Prompt(), new() { Chosen = [] }));
        Assert.Null(ChatRules.AnswerText(Prompt(), null));
    }

    [Fact]
    public void FollowUpsComeFromTheLatestAnswer()
    {
        var detail = Detail([Message(ChatMessageRole.User, 0), Message(ChatMessageRole.Assistant, 1, "next")]);

        Assert.Equal(["next"], ChatRules.FollowUps(detail, false, Now));
    }

    [Fact]
    public void NoFollowUpsWhileTheChatWorksOrAChangeWaits()
    {
        var answer = Message(ChatMessageRole.Assistant, 1, "next");

        Assert.Empty(ChatRules.FollowUps(Detail([answer]), true, Now));
        Assert.Empty(ChatRules.FollowUps(Detail([answer], Proposed(2)), false, Now));
        Assert.Empty(ChatRules.FollowUps(Detail([answer, Message(ChatMessageRole.User, 2)]), false, Now));
    }

    [Fact]
    public void ADecidedChangeNoLongerHoldsBackFollowUps()
    {
        var detail = Detail([Message(ChatMessageRole.Assistant, 1, "next")], Proposed(0, ChatPendingActionStatus.Done));

        Assert.Equal(["next"], ChatRules.FollowUps(detail, false, Now));
    }

    [Fact]
    public void RepeatsOfAReadShareALabelAndAnyFailureShows()
    {
        var activity = Assert.Single(ChatRules.Activity([Ran("list_cards", "demo", true), Ran("list_cards", "demo", false)]));

        Assert.Equal("list cards in demo", activity.Label);
        Assert.True(activity.Failed);
        Assert.Equal("{\"id\":1}\n{\"id\":1}", activity.Arguments);
    }

    [Fact]
    public void ReadsAnOperationEvent()
    {
        var operation = ChatRules.ReadOperation("""{"name":"list_cards","arguments":{},"ok":true}""");

        Assert.Equal("list_cards", operation?.Name);
    }

    [Fact]
    public void AnEventThatIsNotAnOperationIsLeftOut() => Assert.Null(ChatRules.ReadOperation("not json"));

    [Theory]
    [InlineData(-30, "30 seconds ago")]
    [InlineData(-60, "1 minute ago")]
    [InlineData(-7200, "2 hours ago")]
    [InlineData(-172800, "2 days ago")]
    [InlineData(300, "in 5 minutes")]
    [InlineData(0, "0 seconds ago")]
    public void AMomentReadsFromNow(int seconds, string expected) => Assert.Equal(expected, ChatRules.Relative(Now.AddSeconds(seconds), Now));

    [Theory]
    [InlineData("All done.", "All done.")]
    [InlineData("All done.\n\n<suggestions>\n- next", "All done.")]
    [InlineData("All done. <SUGGEST", "All done.")]
    [InlineData("a < b holds", "a < b holds")]
    public void TheFollowUpsBlockNeverShows(string draft, string shown) => Assert.Equal(shown, ChatRules.WithoutSuggestions(draft));

    [Theory]
    [InlineData(ChatPendingActionStatus.Pending, 60, true)]
    [InlineData(ChatPendingActionStatus.Pending, -60, false)]
    [InlineData(ChatPendingActionStatus.Done, 60, false)]
    public void OnlyAPendingUnexpiredActionCanBeAnswered(ChatPendingActionStatus status, int seconds, bool expected)
    {
        var action = new ChatPendingAction
        {
            Id = "a",
            ThreadId = "t",
            Operation = "op",
            Arguments = JsonSerializer.SerializeToElement(new { }),
            Summary = "s",
            Status = status,
            ExpiresAt = DateTimeOffset.UnixEpoch.AddSeconds(seconds),
            CreatedAt = DateTimeOffset.UnixEpoch,
        };

        Assert.Equal(expected, ChatRules.IsAwaiting(action, DateTimeOffset.UnixEpoch));
    }
}
