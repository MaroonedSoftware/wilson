using System.Globalization;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>A kind of account the Accounts section can add, as the names the API keeps it under.</summary>
public sealed record AccountType(string Label, EngineTokenProvider Provider, EngineTokenKind Kind)
{
    public override string ToString() => Label;
}

/// <summary>Which account comes next in a rotation: <see cref="Limit"/> says when, if every one is limited.</summary>
public sealed record NextAccount(string Name, EngineLimit? Limit);

/// <summary>A priority to save for a token moved in a rotation.</summary>
public sealed record PriorityChange(string Name, long Priority);

/// <summary>What `lib/accounts.ts` says, kept in step by hand.</summary>
public static class AccountRules
{
    /// <summary>What a limit is recorded against for engines on the server's own machine.</summary>
    public const string LocalAccount = "local";

    private const long MaxPriority = 1000;

    public static IReadOnlyList<AccountType> Types { get; } =
    [
        new("Claude subscription", EngineTokenProvider.Anthropic, EngineTokenKind.Subscription),
        new("Anthropic API key", EngineTokenProvider.Anthropic, EngineTokenKind.ApiKey),
        new("OpenAI API key", EngineTokenProvider.Openai, EngineTokenKind.ApiKey),
    ];

    /// <summary>A saved token's kind of account, in words.</summary>
    public static string TypeOf(EngineTokenSummary token)
    {
        ArgumentNullException.ThrowIfNull(token);

        return Types.FirstOrDefault(type => type.Provider == token.Provider && type.Kind == token.Kind)?.Label
            ?? $"{token.Provider.ToString().ToLowerInvariant()} {(token.Kind == EngineTokenKind.ApiKey ? "API key" : "subscription")}";
    }

    /// <summary>A limit and when it lifts, such as "Weekly limit, back Thu 5:00 PM". Anything the engine calls it that is not listed is a usage limit.</summary>
    public static string DescribeLimit(EngineLimit limit, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(limit);

        var name = limit.LimitType switch
        {
            "five_hour" => "5-hour limit",
            "seven_day" or "seven_day_overage_included" => "Weekly limit",
            "seven_day_opus" => "Weekly Opus limit",
            "seven_day_sonnet" => "Weekly Sonnet limit",
            "overage" => "Overage limit",
            "rateLimitExceeded" => "Rate limit",
            _ => "Usage limit",
        };
        var local = limit.ResetsAt.ToOffset(now.Offset);
        var format = local.Date == now.Date ? "h:mm tt" : (local - now).TotalDays < 6 ? "ddd h:mm tt" : "MMM d, h:mm tt";
        return $"{name}, back {local.ToString(format, CultureInfo.InvariantCulture)}";
    }

    /// <summary>What a limit's account is called when it is a machine's own sign-in, which has no saved token to show it beside.</summary>
    public static string DescribeSignIn(string account)
    {
        ArgumentNullException.ThrowIfNull(account);

        return account == LocalAccount ? "This server"
            : account.StartsWith("worker:", StringComparison.Ordinal) ? $"{account["worker:".Length..]}'s own sign-in"
            : account.StartsWith("codex:", StringComparison.Ordinal) ? $"Codex on {account["codex:".Length..]}"
            : account;
    }

    /// <summary>The limit keeping <paramref name="account"/> out longest, as the server chooses it, if any has not reset by <paramref name="now"/>.</summary>
    public static EngineLimit? LimitOn(string account, IEnumerable<EngineLimit> limits, DateTimeOffset now) =>
        limits.Where(limit => limit.Account == account && limit.ResetsAt > now).MaxBy(limit => limit.ResetsAt);

    /// <summary>A provider's tokens Wilson may choose between, in the order it tries them.</summary>
    public static IReadOnlyList<EngineTokenSummary> RotationOf(IEnumerable<EngineTokenSummary> tokens, EngineTokenProvider provider = EngineTokenProvider.Anthropic) =>
        [.. tokens.Where(token => token.Pooled && token.Provider == provider).OrderBy(token => token.Priority).ThenBy(token => token.Name, StringComparer.Ordinal)];

    /// <summary>The saved tokens Wilson will not choose by itself, whether or not a host is assigned them. An xAI token is one of these, since no engine draws on it.</summary>
    public static IReadOnlyList<EngineTokenSummary> OutsideRotation(IEnumerable<EngineTokenSummary> tokens) =>
        [.. tokens.Where(token => !InRotation(token))];

    /// <summary>Whether an engine can be given this token without a host being assigned it.</summary>
    public static bool InRotation(EngineTokenSummary token)
    {
        ArgumentNullException.ThrowIfNull(token);

        return token.Pooled && token.Provider is EngineTokenProvider.Anthropic or EngineTokenProvider.Openai;
    }

    /// <summary>
    /// Which account of <paramref name="rotation"/> the next engine with none assigned takes: the first with
    /// no limit in force, or with every one limited the one back soonest. Null for an empty rotation, since
    /// engines then use their machine's own sign-in.
    /// </summary>
    public static NextAccount? Next(IReadOnlyList<EngineTokenSummary> rotation, IReadOnlyList<EngineLimit> limits, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(rotation);

        if (rotation.Count == 0)
        {
            return null;
        }

        var accounts = rotation.Select(token => new NextAccount(token.Name, LimitOn(token.Name, limits, now))).ToList();
        return accounts.Find(account => account.Limit is null) ?? accounts.MinBy(account => account.Limit!.ResetsAt);
    }

    /// <summary>The priority that puts a token last in <paramref name="rotation"/>, so a new account never jumps ahead of the ones already working.</summary>
    public static long LastPriority(IReadOnlyList<EngineTokenSummary> rotation)
    {
        ArgumentNullException.ThrowIfNull(rotation);

        return rotation.Count == 0 ? 0 : Math.Min(MaxPriority, rotation[^1].Priority + 1);
    }

    /// <summary>
    /// The priorities to save to move the token at <paramref name="index"/> by <paramref name="offset"/>: the
    /// new order numbered from 0, leaving out any that already has its number. Priorities can tie, and ties
    /// order by name, so swapping two numbers would not always move anything. Empty when the move runs off either end.
    /// </summary>
    public static IReadOnlyList<PriorityChange> MovedPriorities(IReadOnlyList<EngineTokenSummary> rotation, int index, int offset)
    {
        ArgumentNullException.ThrowIfNull(rotation);

        var target = index + offset;
        if (index < 0 || index >= rotation.Count || target < 0 || target >= rotation.Count)
        {
            return [];
        }

        var order = rotation.ToList();
        var moved = order[index];
        order.RemoveAt(index);
        order.Insert(target, moved);
        return [.. order.Select((token, position) => (token, position)).Where(each => each.token.Priority != each.position).Select(each => new PriorityChange(each.token.Name, each.position))];
    }

    /// <summary>What removing an account does beyond losing the token, which can't be read back to save it again.</summary>
    public static string RemovalWarning(EngineTokenSummary token)
    {
        ArgumentNullException.ThrowIfNull(token);

        var assigned = token.Hosts.Count == 0 ? string.Empty : $" {string.Join(", ", token.Hosts)} {(token.Hosts.Count == 1 ? "goes" : "go")} back to the machine's own sign-in.";
        return $"Remove {token.Name}?{assigned} Running engines carry on, and this doesn't revoke the token with its provider.";
    }

    /// <summary>A name for a new account that is free, so signing in can be one click. Only the desktop app has a sign-in button to want this.</summary>
    public static string SuggestedName(IEnumerable<EngineTokenSummary> tokens)
    {
        var taken = tokens.Select(token => token.Name).ToHashSet();
        return Enumerable.Range(1, taken.Count + 1).Select(number => $"claude-{number}").First(name => !taken.Contains(name));
    }

    /// <summary>The headline and detail saying which account comes next, the question the section is there to answer.</summary>
    public static (string Headline, string Detail) Summary(NextAccount? next, DateTimeOffset now) => next switch
    {
        null => ("No accounts in rotation", "Engines with no account assigned use their machine's own sign-in."),
        { Limit: { } limit } => ("Every account in rotation is at its limit", $"Stages wait for {next.Name}. {DescribeLimit(limit, now)}."),
        _ => ($"Next engine signs in as {next.Name}", "Engines stay on one account until it hits a limit, then move to the next. A host with an account assigned keeps it."),
    };
}
