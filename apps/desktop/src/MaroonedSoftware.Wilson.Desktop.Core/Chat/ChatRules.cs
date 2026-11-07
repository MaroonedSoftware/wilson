using System.Globalization;
using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>One step of a conversation: a message, a change one of them proposed, or a question one of them asked.</summary>
public sealed record ChatStep(ChatMessage? Message, ChatPendingAction? Action, ChatPendingQuestion? Question = null);

/// <summary>What the chat ran, gathered under the label its repeats share.</summary>
public sealed record ChatActivity(string Label, bool Failed, string Arguments);

/// <summary>What the chat decides without a window. The same rules as the web and Android apps.</summary>
public static class ChatRules
{
    private const string SuggestionsOpen = "<suggestions>";

    private static readonly (double Seconds, string Unit)[] Units =
    [
        (31_536_000, "year"),
        (2_592_000, "month"),
        (86_400, "day"),
        (3_600, "hour"),
        (60, "minute"),
        (1, "second"),
    ];

    /// <summary>What a new chat offers to ask, one click each.</summary>
    public static IReadOnlyList<string> Starters { get; } =
    [
        "What is waiting on me?",
        "What is in review right now?",
        "Why did the last card fail testing?",
        "What did the board spend today?",
    ];

    /// <summary>
    /// An answer as it streams, without the follow-ups block the agent ends it on. The API takes that
    /// off the stored answer; a trailing piece that may be the block starting is held back until it
    /// is clearly not.
    /// </summary>
    public static string WithoutSuggestions(string draft)
    {
        ArgumentNullException.ThrowIfNull(draft);

        var start = draft.IndexOf(SuggestionsOpen, StringComparison.OrdinalIgnoreCase);
        if (start != -1)
        {
            return draft[..start].TrimEnd();
        }

        var opening = draft.LastIndexOf('<');
        return opening != -1 && SuggestionsOpen.StartsWith(draft[opening..], StringComparison.OrdinalIgnoreCase) ? draft[..opening].TrimEnd() : draft;
    }

    /// <summary>Whether a proposed action can still be answered. An expired one stays on record as it was.</summary>
    public static bool IsAwaiting(ChatPendingAction action, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(action);

        return action.Status == ChatPendingActionStatus.Pending && action.ExpiresAt > now;
    }

    /// <summary>Whether a question still waits on the person: past its expiry the server would refuse an answer.</summary>
    public static bool IsUnanswered(ChatPendingQuestion question, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(question);

        return question.Status == ChatPendingQuestionStatus.Pending && question.ExpiresAt > now;
    }

    /// <summary>How a question went, for its card. Null while it still waits; past its expiry it reads as expired though it is stored as pending.</summary>
    public static string? QuestionOutcome(ChatPendingQuestion question, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(question);

        return question.Status switch
        {
            ChatPendingQuestionStatus.Pending => IsUnanswered(question, now) ? null : "expired",
            ChatPendingQuestionStatus.Answered => "answered",
            ChatPendingQuestionStatus.Dismissed => "dismissed",
            _ => "unknown",
        };
    }

    /// <summary>A given answer as it reads in the conversation: the chosen labels, then any "Other" text, joined. Null when there is none.</summary>
    public static string? AnswerText(ChatQuestion question, ChatQuestionAnswer? given)
    {
        ArgumentNullException.ThrowIfNull(question);

        if (given is null)
        {
            return null;
        }

        var labels = given.Chosen.Where(index => index >= 0 && index < question.Options.Count).Select(index => question.Options[(int)index].Label);
        var parts = labels.Concat(string.IsNullOrEmpty(given.Other) ? [] : [given.Other]).ToList();
        return parts.Count > 0 ? string.Join(", ", parts) : null;
    }

    /// <summary>Messages, proposed changes and asked questions in the order they happened, so each sits beside the answer that raised it.</summary>
    public static IReadOnlyList<ChatStep> Timeline(IEnumerable<ChatMessage> messages, IEnumerable<ChatPendingAction> actions, IEnumerable<ChatPendingQuestion>? questions = null)
    {
        ArgumentNullException.ThrowIfNull(messages);
        ArgumentNullException.ThrowIfNull(actions);

        return
        [
            .. messages.Select(message => (At: message.CreatedAt, Step: new ChatStep(message, null)))
                .Concat(actions.Select(action => (At: action.CreatedAt, Step: new ChatStep(null, action))))
                .Concat((questions ?? []).Select(question => (At: question.CreatedAt, Step: new ChatStep(null, null, question))))
                .OrderBy(entry => entry.At)
                .Select(entry => entry.Step),
        ];
    }

    /// <summary>What to ask next follows from the latest answer, until the chat is working again or a change or question waits on the person.</summary>
    public static IReadOnlyList<string> FollowUps(ChatThreadDetail detail, bool answering, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(detail);

        return !answering
            && detail.Messages.LastOrDefault() is { Role: ChatMessageRole.Assistant } last
            && !detail.Actions.Any(action => IsAwaiting(action, now))
            && !detail.Questions.Any(question => IsUnanswered(question, now))
                ? last.Suggestions ?? []
                : [];
    }

    /// <summary>`list_cards` in `demo` as `list cards in demo`, and each label once however often it ran.</summary>
    public static IReadOnlyList<ChatActivity> Activity(IEnumerable<ChatOperation> operations)
    {
        ArgumentNullException.ThrowIfNull(operations);

        return
        [
            .. operations.GroupBy(Label).Select(runs => new ChatActivity(
                runs.Key,
                !runs.All(run => run.Ok),
                string.Join('\n', runs.Select(run => run.Arguments.GetRawText())))),
        ];
    }

    /// <summary>An `operation` event from the stream, or null if it is not one.</summary>
    public static ChatOperation? ReadOperation(string data)
    {
        ArgumentNullException.ThrowIfNull(data);

        try
        {
            return JsonSerializer.Deserialize<ChatOperation>(data);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>How the moment reads from now: "5 minutes ago", or "in 5 minutes".</summary>
    public static string Relative(DateTimeOffset at, DateTimeOffset now)
    {
        var seconds = (at - now).TotalSeconds;
        var (size, unit) = Units.FirstOrDefault(entry => Math.Abs(seconds) >= entry.Seconds, Units[^1]);
        var count = (long)Math.Truncate(Math.Abs(seconds) / size);
        var amount = string.Create(CultureInfo.InvariantCulture, $"{count} {unit}{(count == 1 ? string.Empty : "s")}");
        return seconds > 0 ? $"in {amount}" : $"{amount} ago";
    }

    private static string Label(ChatOperation operation) =>
        operation.Name.Replace('_', ' ') + (operation.Project is { } project ? $" in {project}" : string.Empty);
}
