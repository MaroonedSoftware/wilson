using System.Globalization;
using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>One step of a conversation: a message, or a change one of them proposed.</summary>
public sealed record ChatStep(ChatMessage? Message, ChatPendingAction? Action);

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

    /// <summary>Messages and proposed changes in the order they happened, so a change sits beside the answer that proposed it.</summary>
    public static IReadOnlyList<ChatStep> Timeline(IEnumerable<ChatMessage> messages, IEnumerable<ChatPendingAction> actions)
    {
        ArgumentNullException.ThrowIfNull(messages);
        ArgumentNullException.ThrowIfNull(actions);

        return
        [
            .. messages.Select(message => (At: message.CreatedAt, Step: new ChatStep(message, null)))
                .Concat(actions.Select(action => (At: action.CreatedAt, Step: new ChatStep(null, action))))
                .OrderBy(entry => entry.At)
                .Select(entry => entry.Step),
        ];
    }

    /// <summary>What to ask next follows from the latest answer, until the chat is working again or a change waits on the person.</summary>
    public static IReadOnlyList<string> FollowUps(ChatThreadDetail detail, bool answering, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(detail);

        return !answering
            && detail.Messages.LastOrDefault() is { Role: ChatMessageRole.Assistant } last
            && !detail.Actions.Any(action => IsAwaiting(action, now))
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
