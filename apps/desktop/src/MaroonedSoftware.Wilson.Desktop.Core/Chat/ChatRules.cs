using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>What the chat decides without a window. The same rules as the web and Android apps.</summary>
public static class ChatRules
{
    private const string SuggestionsOpen = "<suggestions>";

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
}
