namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>
/// Whether a draft's open comments can go to the agent as one revision request. It revises its own
/// copy of the draft, so an edit it has not been given would be overwritten, or commented past.
/// </summary>
public static class PlanFeedback
{
    public const string UnsavedEdits = "The agent can't see your edits to the draft. Approve or discard them to send feedback.";

    /// <summary>What the server stores a feedback turn sent with an empty box as, shown until the stream replays it.</summary>
    public const string EmptyTurn = "[address comments]";

    public static string Summary(int open) => open == 1 ? "1 comment to send" : $"{open} comments to send";

    public static bool CanSend(int open, bool dirty, bool sending) => open > 0 && !dirty && !sending;

    public static string? Blocked(int open, bool dirty) => open > 0 && dirty ? UnsavedEdits : null;
}
