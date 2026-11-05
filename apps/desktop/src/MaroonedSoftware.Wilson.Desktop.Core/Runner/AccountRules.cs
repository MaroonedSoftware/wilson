using System.Globalization;
using MaroonedSoftware.Wilson.Desktop.Core.MenuBar;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>A kind of account the Accounts section can add, as the names the API keeps it under.</summary>
public sealed record AccountType(string Label, EngineTokenProvider Provider, EngineTokenKind Kind)
{
    public override string ToString() => Label;
}

/// <summary>Which account comes next in a rotation: <see cref="Limit"/> says when, if every one is limited.</summary>
public sealed record NextAccount(string Name, EngineLimit? Limit);

/// <summary>
/// An account and how it stands, as a line: <see cref="Limited"/> when a limit keeps engines off it, and
/// <see cref="Spend"/> what it spent, when that was read.
/// </summary>
public sealed record AccountLine(string Name, string Status, bool Limited, string? Spend = null);

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

    /// <summary>
    /// What an account spent, such as "120K today, 1.4M in 14 days", from its row of
    /// `GET /api/engine-accounts/usage`. No row means it spent nothing in the window.
    /// </summary>
    public static string DescribeSpend(EngineAccountUsage? usage, int days) =>
        usage is null || usage.OutputTokens == 0
            ? $"Nothing in {days} days"
            : $"{MenuBarStats.Compact(usage.TodayOutputTokens)} today, {MenuBarStats.Compact(usage.OutputTokens)} in {days} days";

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

    /// <summary>
    /// Every account engines can sign in as, one line each, in the order the Accounts section shows them:
    /// the Claude rotation, the OpenAI rotation, then the saved tokens outside both. A machine's own
    /// sign-in is only an account while its provider's rotation is empty, since otherwise no engine uses
    /// it. This server's then always has a line, and a worker's or a Codex one only while it is limited,
    /// as nothing else is known about them. With no <paramref name="tokens"/> read, every limit in force
    /// is a line, as nothing says which accounts are unused. With <paramref name="usage"/> read, over
    /// <paramref name="days"/>, each line says what its account spent.
    /// </summary>
    public static IReadOnlyList<AccountLine> Lines(
        IReadOnlyList<EngineTokenSummary>? tokens,
        IReadOnlyList<EngineLimit> limits,
        DateTimeOffset now,
        IReadOnlyList<EngineAccountUsage>? usage = null,
        int days = 0)
    {
        ArgumentNullException.ThrowIfNull(limits);

        string? Spend(string account) => usage is null ? null : DescribeSpend(usage.FirstOrDefault(row => row.Account == account), days);
        AccountLine? Limited(string account, string name) =>
            LimitOn(account, limits, now) is { } limit ? new AccountLine(name, DescribeLimit(limit, now), Limited: true, Spend(account)) : null;

        if (tokens is null)
        {
            return [.. limits.Where(limit => limit.ResetsAt > now).Select(limit => limit.Account).Distinct().Select(account => Limited(account, DescribeSignIn(account))!)];
        }

        AccountLine Line(EngineTokenSummary token, IReadOnlyList<EngineTokenSummary>? rotation)
        {
            if (Limited(token.Name, token.Name) is { } limited)
            {
                return limited;
            }
            if (rotation is null)
            {
                return new AccountLine(token.Name, token.Hosts.Count == 0 ? "Not in rotation" : $"Assigned to {string.Join(", ", token.Hosts)}", Limited: false, Spend(token.Name));
            }
            return new AccountLine(token.Name, Next(rotation, limits, now)?.Name == token.Name ? "Next" : "Ready", Limited: false, Spend(token.Name));
        }

        var claude = RotationOf(tokens);
        var openai = RotationOf(tokens, EngineTokenProvider.Openai);
        var lines = new List<AccountLine>();
        lines.AddRange(claude.Select(token => Line(token, claude)));
        lines.AddRange(openai.Select(token => Line(token, openai)));
        lines.AddRange(OutsideRotation(tokens).Select(token => Line(token, null)));

        var saved = tokens.Select(token => token.Name).ToHashSet();
        var signIns = limits.Select(limit => limit.Account).Distinct().Where(account => account != LocalAccount && !saved.Contains(account));
        if (claude.Count == 0)
        {
            lines.Add(Limited(LocalAccount, DescribeSignIn(LocalAccount)) ?? new AccountLine(DescribeSignIn(LocalAccount), "Own sign-in", Limited: false, Spend(LocalAccount)));
            lines.AddRange(signIns.Where(account => account.StartsWith("worker:", StringComparison.Ordinal)).Select(account => Limited(account, DescribeSignIn(account))).OfType<AccountLine>());
        }
        if (openai.Count == 0)
        {
            lines.AddRange(signIns.Where(account => account.StartsWith("codex:", StringComparison.Ordinal)).Select(account => Limited(account, DescribeSignIn(account))).OfType<AccountLine>());
        }
        return lines;
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
