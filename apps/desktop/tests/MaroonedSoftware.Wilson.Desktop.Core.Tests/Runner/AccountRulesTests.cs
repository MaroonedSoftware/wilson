using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Runner;

public sealed class AccountRulesTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 3, 12, 0, 0, TimeSpan.FromHours(-5));

    private static EngineTokenSummary Token(string name, long priority = 0, bool pooled = true, EngineTokenProvider provider = EngineTokenProvider.Anthropic, EngineTokenKind kind = EngineTokenKind.Subscription, params string[] hosts) => new()
    {
        Name = name,
        Provider = provider,
        Kind = kind,
        Priority = priority,
        Pooled = pooled,
        CreatedAt = Now,
        UpdatedAt = Now,
        Hosts = [.. hosts],
    };

    private static EngineLimit Limit(string account, DateTimeOffset resetsAt, string limitType = "seven_day") => new() { Account = account, LimitType = limitType, ResetsAt = resetsAt };

    [Fact]
    public void A_rotation_is_ordered_by_priority_then_name_as_the_server_does()
    {
        var names = AccountRules.RotationOf([Token("c", priority: 1), Token("b"), Token("a")]).Select(token => token.Name);
        Assert.Equal(["a", "b", "c"], names);
    }

    [Fact]
    public void A_rotation_leaves_out_tokens_not_pooled_and_other_providers()
    {
        EngineTokenSummary[] tokens = [Token("claude"), Token("held", pooled: false), Token("codex", provider: EngineTokenProvider.Openai, kind: EngineTokenKind.ApiKey)];
        Assert.Equal(["claude"], AccountRules.RotationOf(tokens).Select(token => token.Name));
        Assert.Equal(["codex"], AccountRules.RotationOf(tokens, EngineTokenProvider.Openai).Select(token => token.Name));
    }

    [Fact]
    public void Outside_the_rotation_is_a_token_not_pooled_or_one_no_engine_draws_on()
    {
        EngineTokenSummary[] tokens = [Token("claude"), Token("held", pooled: false), Token("grok", provider: EngineTokenProvider.Xai, kind: EngineTokenKind.ApiKey)];
        Assert.Equal(["held", "grok"], AccountRules.OutsideRotation(tokens).Select(token => token.Name));
    }

    [Fact]
    public void The_limit_on_an_account_is_the_one_keeping_it_out_longest()
    {
        EngineLimit[] limits = [Limit("a", Now.AddHours(1), "five_hour"), Limit("a", Now.AddDays(2)), Limit("b", Now.AddDays(5))];
        Assert.Equal("seven_day", AccountRules.LimitOn("a", limits, Now)?.LimitType);
    }

    [Fact]
    public void A_limit_that_has_reset_since_it_was_read_is_ignored() =>
        Assert.Null(AccountRules.LimitOn("a", [Limit("a", Now.AddMinutes(-1))], Now));

    [Fact]
    public void An_empty_rotation_has_no_next_account() => Assert.Null(AccountRules.Next([], [], Now));

    [Fact]
    public void Next_is_the_first_with_no_limit_however_soon_the_others_reset()
    {
        var next = AccountRules.Next([Token("a"), Token("b"), Token("c")], [Limit("a", Now.AddMinutes(1))], Now);
        Assert.Equal(new NextAccount("b", null), next);
    }

    [Fact]
    public void Next_is_the_one_back_soonest_when_every_one_is_limited()
    {
        var soonest = Limit("b", Now.AddHours(1));
        Assert.Equal(new NextAccount("b", soonest), AccountRules.Next([Token("a"), Token("b")], [Limit("a", Now.AddDays(1)), soonest], Now));
    }

    [Fact]
    public void Last_priority_starts_at_0_and_goes_no_further_than_the_API_allows()
    {
        Assert.Equal(0, AccountRules.LastPriority([]));
        Assert.Equal(5, AccountRules.LastPriority([Token("a", priority: 4)]));
        Assert.Equal(1000, AccountRules.LastPriority([Token("a", priority: 1000)]));
    }

    [Fact]
    public void A_move_numbers_the_new_order_so_it_works_among_tied_priorities()
    {
        var rotation = AccountRules.RotationOf([Token("a"), Token("b"), Token("c")]);
        Assert.Equal([new PriorityChange("c", 1), new PriorityChange("b", 2)], AccountRules.MovedPriorities(rotation, 2, -1));
    }

    [Fact]
    public void A_move_sends_only_the_priorities_that_change()
    {
        var rotation = AccountRules.RotationOf([Token("a", priority: 0), Token("b", priority: 1), Token("c", priority: 2)]);
        Assert.Equal([new PriorityChange("b", 0), new PriorityChange("a", 1)], AccountRules.MovedPriorities(rotation, 0, 1));
    }

    [Fact]
    public void A_move_off_either_end_does_nothing()
    {
        EngineTokenSummary[] rotation = [Token("a"), Token("b")];
        Assert.Empty(AccountRules.MovedPriorities(rotation, 0, -1));
        Assert.Empty(AccountRules.MovedPriorities(rotation, 1, 1));
    }

    [Theory]
    [InlineData("five_hour", "5-hour limit")]
    [InlineData("seven_day", "Weekly limit")]
    [InlineData("seven_day_opus", "Weekly Opus limit")]
    [InlineData("unknown", "Usage limit")]
    [InlineData("anything_else", "Usage limit")]
    public void A_limit_is_named(string limitType, string name) =>
        Assert.Contains(name, AccountRules.DescribeLimit(Limit("a", Now.AddHours(1), limitType), Now));

    [Fact]
    public void A_limit_back_today_gives_only_the_time() =>
        Assert.Equal("5-hour limit, back 5:00 PM", AccountRules.DescribeLimit(Limit("a", Now.AddHours(5), "five_hour"), Now));

    [Fact]
    public void A_limit_back_this_week_gives_the_day() =>
        Assert.Equal("Weekly limit, back Thu 5:00 PM", AccountRules.DescribeLimit(Limit("a", Now.AddDays(2).AddHours(5)), Now));

    [Fact]
    public void A_limit_further_off_gives_the_date() =>
        Assert.Equal("Weekly limit, back Nov 10, 12:00 PM", AccountRules.DescribeLimit(Limit("a", Now.AddDays(7)), Now));

    [Fact]
    public void A_limit_reads_in_the_viewers_zone_whatever_zone_it_arrived_in() =>
        Assert.Equal("5-hour limit, back 5:00 PM", AccountRules.DescribeLimit(Limit("a", Now.AddHours(5).ToUniversalTime(), "five_hour"), Now));

    [Theory]
    [InlineData("local", "This server")]
    [InlineData("worker:my-mac", "my-mac's own sign-in")]
    [InlineData("codex:my-mac", "Codex on my-mac")]
    [InlineData("removed-token", "removed-token")]
    public void A_sign_in_is_named(string account, string words) => Assert.Equal(words, AccountRules.DescribeSignIn(account));

    [Fact]
    public void A_type_names_what_the_form_can_add_and_any_other_in_plain_terms()
    {
        Assert.Equal("Claude subscription", AccountRules.TypeOf(Token("a")));
        Assert.Equal("Anthropic API key", AccountRules.TypeOf(Token("a", kind: EngineTokenKind.ApiKey)));
        Assert.Equal("OpenAI API key", AccountRules.TypeOf(Token("a", provider: EngineTokenProvider.Openai, kind: EngineTokenKind.ApiKey)));
        Assert.Equal("xai API key", AccountRules.TypeOf(Token("a", provider: EngineTokenProvider.Xai, kind: EngineTokenKind.ApiKey)));
    }

    [Fact]
    public void Removing_names_the_hosts_that_lose_the_account()
    {
        Assert.Contains("my-mac goes back", AccountRules.RemovalWarning(Token("a", hosts: "my-mac")));
        Assert.Contains("x, y go back", AccountRules.RemovalWarning(Token("a", hosts: ["x", "y"])));
        Assert.DoesNotContain("back to", AccountRules.RemovalWarning(Token("a")));
    }

    [Fact]
    public void A_suggested_name_is_the_first_free_one()
    {
        Assert.Equal("claude-1", AccountRules.SuggestedName([]));
        Assert.Equal("claude-1", AccountRules.SuggestedName([Token("pool-a")]));
        Assert.Equal("claude-3", AccountRules.SuggestedName([Token("claude-1"), Token("claude-2")]));
        Assert.Equal("claude-2", AccountRules.SuggestedName([Token("claude-1"), Token("claude-3")]));
    }

    [Fact]
    public void The_summary_says_who_is_next_or_why_nobody_is()
    {
        Assert.Equal("No accounts in rotation", AccountRules.Summary(null, Now).Headline);
        Assert.Equal("Next engine signs in as a", AccountRules.Summary(new NextAccount("a", null), Now).Headline);
        var limited = AccountRules.Summary(new NextAccount("a", Limit("a", Now.AddHours(5), "five_hour")), Now);
        Assert.Equal("Every account in rotation is at its limit", limited.Headline);
        Assert.Equal("Stages wait for a. 5-hour limit, back 5:00 PM.", limited.Detail);
    }
}
