using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>What a card waits on a person for, most pressing first. A card waits on at most one.</summary>
public enum Attention
{
    /// <summary>A stage stopped to ask something (`blocked`).</summary>
    Question,

    /// <summary>Flagged for any other reason.</summary>
    Flag,

    /// <summary>In `planning` with no scope check running, so approving is the next step.</summary>
    Plan,

    /// <summary>In `ready` with no pull request, and a merge check that is clean or not yet made.</summary>
    Merge,

    /// <summary>In `ready`, but Merge would conflict or send it back to review, or the check itself failed.</summary>
    Conflict,
}

/// <summary>The board's chips, each a narrowing of the whole project.</summary>
public enum BoardNarrowing
{
    All,
    NeedsYou,
    Flagged,
    Questions,
    Plans,
    Merges,
    Conflicts,
}

/// <summary>Which cards wait on a person and for what. Read from the card's own record, the same one the tiles use.</summary>
public static class BoardAttention
{
    public const string Planning = "planning";

    public const string Ready = "ready";

    /// <summary>The chips in the order drawn.</summary>
    public static IReadOnlyList<BoardNarrowing> Narrowings { get; } = Enum.GetValues<BoardNarrowing>();

    /// <summary>What the card waits on a person for, or none when it waits on nobody.</summary>
    public static Attention? Of(CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        return card switch
        {
            { Blocked: not null } => Attention.Question,
            { NeedsHuman: true } => Attention.Flag,
            { Stage: Planning, PlanCheck: not CardSummaryPlanCheck.Checking } => Attention.Plan,
            { Stage: Ready, PullRequest: null, MergeStatus: null or { State: MergeStatusState.Clean } } => Attention.Merge,
            { Stage: Ready, PullRequest: null } => Attention.Conflict,
            _ => null,
        };
    }

    /// <summary>Whether a chip keeps the card. Flagged is every flagged card, questions included, as the header's count is.</summary>
    public static bool Shows(BoardNarrowing narrowing, CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        var attention = Of(card);
        return narrowing switch
        {
            BoardNarrowing.NeedsYou => attention is not null,
            BoardNarrowing.Flagged => card.NeedsHuman,
            BoardNarrowing.Questions => attention == Attention.Question,
            BoardNarrowing.Plans => attention == Attention.Plan,
            BoardNarrowing.Merges => attention == Attention.Merge,
            BoardNarrowing.Conflicts => attention == Attention.Conflict,
            _ => true,
        };
    }

    /// <summary>A chip's words, without its count.</summary>
    public static string Label(BoardNarrowing narrowing) =>
        narrowing switch
        {
            BoardNarrowing.NeedsYou => "Needs you",
            BoardNarrowing.Flagged => "Flagged",
            BoardNarrowing.Questions => "Questions",
            BoardNarrowing.Plans => "Plans to approve",
            BoardNarrowing.Merges => "Ready to merge",
            BoardNarrowing.Conflicts => "Merge problems",
            _ => "All",
        };

    /// <summary>The board's heading under a chip.</summary>
    public static string Heading(BoardNarrowing narrowing) =>
        narrowing switch
        {
            BoardNarrowing.All => "Board",
            BoardNarrowing.Flagged => "Cards needing a human",
            _ => Label(narrowing),
        };

    /// <summary>What a chip with nothing in it says, or none for All, whose empty board says enough.</summary>
    public static string? Empty(BoardNarrowing narrowing) =>
        narrowing switch
        {
            BoardNarrowing.All => null,
            BoardNarrowing.NeedsYou => "Nothing needs you right now.",
            BoardNarrowing.Flagged => "Nothing is flagged right now.",
            _ => $"No cards: {Label(narrowing)}.",
        };

    /// <summary>A waiting card's kind, as its pill says it.</summary>
    public static string Kind(Attention attention) =>
        attention switch
        {
            Attention.Question => "Question",
            Attention.Flag => "Flagged",
            Attention.Plan => "Plan",
            Attention.Merge => "Ready to merge",
            _ => "Merge problem",
        };

    /// <summary>The one line under a waiting card's title: what it is waiting on, in the card's own words where it has some.</summary>
    public static string Detail(CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        return Of(card) switch
        {
            Attention.Question => card.Blocked!.Question,
            Attention.Flag => card.NeedsHumanReason ?? "Needs you.",
            Attention.Plan => BoardRules.PlanCheck(card.PlanCheck, card.PlanCheckReason) ?? "The plan waits for approval.",
            Attention.Merge => BoardRules.MergeStatusLine(card.MergeStatus) ?? "Ready to merge.",
            Attention.Conflict => BoardRules.MergeStatusLine(card.MergeStatus)!,
            _ => string.Empty,
        };
    }

    /// <summary>
    /// The press a waiting card offers first. Merging runs the suite and asks to be confirmed, so Merge
    /// and its problems open the card rather than act from the list.
    /// </summary>
    public static string Action(CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        return Of(card) switch
        {
            Attention.Question => "Answer",
            Attention.Flag => "Acknowledge",
            Attention.Plan => card.PlanCheck == CardSummaryPlanCheck.Refused ? "Approve again" : "Approve plan",
            Attention.Merge => "Review and merge",
            _ => "Open",
        };
    }

    /// <summary>Since when the card has waited: a question since it was asked, anything else since it entered its stage.</summary>
    public static DateTimeOffset? Since(CardSummary card)
    {
        ArgumentNullException.ThrowIfNull(card);

        return card.Blocked?.AskedAt ?? card.StageEnteredAt;
    }

    /// <summary>
    /// The cards waiting on a person, most pressing kind first and the longest waiting first within a
    /// kind. A question has waited since it was asked, anything else since it entered its stage.
    /// </summary>
    public static IReadOnlyList<CardSummary> Waiting(IEnumerable<CardSummary> cards) =>
        [.. cards
            .Select(card => (card, attention: Of(card)))
            .Where(pair => pair.attention is not null)
            .OrderBy(pair => pair.attention)
            .ThenBy(pair => Since(pair.card) ?? DateTimeOffset.MaxValue)
            .ThenBy(pair => pair.card.Id, StringComparer.Ordinal)
            .Select(pair => pair.card)];
}
