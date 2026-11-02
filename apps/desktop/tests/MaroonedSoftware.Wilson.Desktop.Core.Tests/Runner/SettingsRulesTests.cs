using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Runner;

public sealed class SettingsRulesTests
{
    private static DrainStatus Drain(bool draining, bool safe = false, params DrainRunningCard[] running) => new()
    {
        Draining = draining,
        Running = [.. running],
        Held = 2,
        PlanDrafts = 1,
        SafeToRestart = safe,
    };

    [Fact]
    public void A_server_not_draining_says_nothing()
    {
        Assert.Null(SettingsRules.DrainBadge(Drain(false, safe: true)));
        Assert.Null(SettingsRules.DrainLine(Drain(false)));
    }

    [Fact]
    public void The_badge_says_when_a_restart_is_safe()
    {
        Assert.Equal("Draining", SettingsRules.DrainBadge(Drain(true)));
        Assert.Equal("Safe to restart", SettingsRules.DrainBadge(Drain(true, safe: true)));
    }

    [Fact]
    public void The_line_names_what_is_still_running() =>
        Assert.Equal(
            "Not safe to restart yet. 1 running (wilson/0001), 2 held, 1 plan drafts.",
            SettingsRules.DrainLine(Drain(true, false, new DrainRunningCard { Project = "wilson", CardId = "0001" })));

    [Fact]
    public void The_line_with_nothing_running_lists_no_cards() =>
        Assert.Equal("Safe to restart. 0 running, 2 held, 1 plan drafts.", SettingsRules.DrainLine(Drain(true, safe: true)));

    [Theory]
    [InlineData(EngineTokenSettingSource.Database, "the token saved here")]
    [InlineData(EngineTokenSettingSource.Environment, "CLAUDE_CODE_OAUTH_TOKEN")]
    [InlineData(EngineTokenSettingSource.None, "No token is set")]
    public void The_source_of_a_sign_in_is_said_in_words(EngineTokenSettingSource source, string expected) =>
        Assert.Contains(expected, SettingsRules.EngineTokenSource(source), StringComparison.Ordinal);

    [Fact]
    public void The_chat_engine_says_what_it_costs()
    {
        Assert.Contains("No API key needed", SettingsRules.ChatEngineHint(ChatEngineSettingEngine.Cli), StringComparison.Ordinal);
        Assert.Contains("billed per token", SettingsRules.ChatEngineHint(ChatEngineSettingEngine.Api), StringComparison.Ordinal);
    }

    [Fact]
    public void The_github_key_is_reported_and_never_asked_for()
    {
        Assert.Equal("Private key found.", SettingsRules.GitHubKey(true));
        Assert.Contains("secrets/github-app.pem", SettingsRules.GitHubKey(false), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("   ", null)]
    [InlineData(" /a/b ", "/a/b")]
    public void Sent_spells_empty_as_not_set(string? draft, string? expected) =>
        Assert.Equal(expected, SettingsRules.Sent(draft));

    [Fact]
    public void Still_saved_names_a_value_or_its_absence()
    {
        Assert.Equal("Still saved: not set", SettingsRules.StillSaved(null));
        Assert.Equal("Still saved: https://a", SettingsRules.StillSaved("https://a"));
    }
}
