using System.Collections.Immutable;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>
/// What the person has picked so far on one question card: per question, the options ticked by index and
/// the "Other" text. The web app's `ChatQuestionCard` and Android's `QuestionDraft` rules: a single choice is
/// one answer, so picking an option clears "Other" and typing "Other" clears the option, and "Other" is cut
/// at <see cref="MaxOtherLength"/>.
/// </summary>
public sealed record QuestionDraft(ImmutableList<ImmutableSortedSet<int>> Chosen, ImmutableList<string> Other)
{
    /// <summary>
    /// The longest the person's free-text "Other" answer may be. The source of truth is `MAX_OTHER_LENGTH` in
    /// `apps/api/src/modules/chat/chat.questions.ts`, which this app cannot import.
    /// </summary>
    public const int MaxOtherLength = 500;

    /// <summary>Whether Submit may be pressed: every question has a choice or non-blank "Other" text.</summary>
    public bool Complete => Chosen.Select((chosen, i) => chosen.Count > 0 || !string.IsNullOrWhiteSpace(Other[i])).All(answered => answered);

    /// <summary>Nothing picked on any of <paramref name="questions"/>.</summary>
    public static QuestionDraft Empty(IReadOnlyList<ChatQuestion> questions)
    {
        ArgumentNullException.ThrowIfNull(questions);

        return new([.. questions.Select(_ => ImmutableSortedSet<int>.Empty)], [.. questions.Select(_ => string.Empty)]);
    }

    /// <summary>Ticks or unticks <paramref name="option"/> on question <paramref name="index"/>; on a single choice it replaces whatever was picked.</summary>
    public QuestionDraft Choose(IReadOnlyList<ChatQuestion> questions, int index, int option)
    {
        ArgumentNullException.ThrowIfNull(questions);

        if (!questions[index].MultiSelect)
        {
            return new(Chosen.SetItem(index, [option]), Other.SetItem(index, string.Empty));
        }

        var now = Chosen[index];
        var without = now.Remove(option);
        return this with { Chosen = Chosen.SetItem(index, without.Count < now.Count ? without : now.Add(option)) };
    }

    /// <summary>Sets question <paramref name="index"/>'s "Other" text, cut to <see cref="MaxOtherLength"/>; on a single choice, text replaces the option picked.</summary>
    public QuestionDraft Type(IReadOnlyList<ChatQuestion> questions, int index, string text)
    {
        ArgumentNullException.ThrowIfNull(questions);
        ArgumentNullException.ThrowIfNull(text);

        var typed = text.Length > MaxOtherLength ? text[..MaxOtherLength] : text;
        var picked = !questions[index].MultiSelect && !string.IsNullOrWhiteSpace(typed) ? Chosen.SetItem(index, []) : Chosen;
        return new(picked, Other.SetItem(index, typed));
    }

    /// <summary>The request body, one answer per question in order: indexes ascending, "Other" trimmed and left out when blank.</summary>
    public List<ChatQuestionAnswer> Answers() =>
    [
        .. Chosen.Select((chosen, i) => new ChatQuestionAnswer
        {
            Chosen = [.. chosen.Select(index => (long)index)],
            Other = string.IsNullOrWhiteSpace(Other[i]) ? null : Other[i].Trim(),
        }),
    ];
}
