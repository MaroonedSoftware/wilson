using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class QuestionDraftTests
{
    private static ChatQuestion Prompt(bool multiSelect) => new()
    {
        Header = "h",
        Text = "t",
        Options = [new() { Label = "a", Description = "d" }, new() { Label = "b", Description = "d" }, new() { Label = "c", Description = "d" }],
        MultiSelect = multiSelect,
    };

    private static readonly List<ChatQuestion> Single = [Prompt(false)];

    private static readonly List<ChatQuestion> Multi = [Prompt(true)];

    [Fact]
    public void NothingPickedIsIncomplete() => Assert.False(QuestionDraft.Empty(Single).Complete);

    [Fact]
    public void ASingleChoiceReplacesWhatWasPicked()
    {
        var draft = QuestionDraft.Empty(Single).Choose(Single, 0, 0).Choose(Single, 0, 2);

        Assert.Equal([2], draft.Chosen[0]);
        Assert.True(draft.Complete);
    }

    [Fact]
    public void AMultipleChoiceTogglesEachOption()
    {
        var draft = QuestionDraft.Empty(Multi).Choose(Multi, 0, 2).Choose(Multi, 0, 0).Choose(Multi, 0, 1).Choose(Multi, 0, 1);

        Assert.Equal([0, 2], draft.Chosen[0]);
    }

    [Fact]
    public void OnASingleChoiceOtherAndAnOptionReplaceEachOther()
    {
        var typed = QuestionDraft.Empty(Single).Choose(Single, 0, 1).Type(Single, 0, "mine");

        Assert.Empty(typed.Chosen[0]);
        Assert.Equal("mine", typed.Other[0]);

        var picked = typed.Choose(Single, 0, 0);

        Assert.Equal([0], picked.Chosen[0]);
        Assert.Equal(string.Empty, picked.Other[0]);
    }

    [Fact]
    public void OnAMultipleChoiceOtherKeepsTheOptions()
    {
        var draft = QuestionDraft.Empty(Multi).Choose(Multi, 0, 1).Type(Multi, 0, "and this");

        Assert.Equal([1], draft.Chosen[0]);
        Assert.Equal("and this", draft.Other[0]);
    }

    [Fact]
    public void BlankOtherAnswersNothing()
    {
        var draft = QuestionDraft.Empty(Single).Type(Single, 0, "   ");

        Assert.False(draft.Complete);
    }

    [Fact]
    public void OtherIsCutAtTheServersLimit() =>
        Assert.Equal(QuestionDraft.MaxOtherLength, QuestionDraft.Empty(Single).Type(Single, 0, new string('x', 600)).Other[0].Length);

    [Fact]
    public void EveryQuestionNeedsAnAnswer()
    {
        List<ChatQuestion> two = [Prompt(false), Prompt(true)];
        var draft = QuestionDraft.Empty(two).Choose(two, 0, 0);

        Assert.False(draft.Complete);
        Assert.True(draft.Type(two, 1, "x").Complete);
    }

    [Fact]
    public void AnswersAreSortedAndTrimmed()
    {
        var answers = QuestionDraft.Empty(Multi).Choose(Multi, 0, 2).Choose(Multi, 0, 0).Type(Multi, 0, "  mine  ").Answers();

        var answer = Assert.Single(answers);
        Assert.Equal([0L, 2L], answer.Chosen);
        Assert.Equal("mine", answer.Other);
        Assert.Null(QuestionDraft.Empty(Single).Choose(Single, 0, 1).Answers()[0].Other);
    }
}
