using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Runner;

public sealed class LaneRulesTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    private static Lane Lane(string instructions = "Do it.") => new()
    {
        Name = "implementing",
        Position = 2,
        Mode = LaneMode.Agent,
        Worktree = LaneWorktree.Readonly,
        OnPass = "review",
        OnFail = "implementing",
        Instructions = instructions,
        Settings = Json("{}"),
    };

    private static string Sent(string stored, string? draft) =>
        LaneRules.ReadSettings(Json(stored), draft).Patch?.GetRawText() ?? "nothing";

    [Fact]
    public void A_summary_says_what_the_page_only_shows() =>
        Assert.Equal("agent, worktree readonly, passes to review, fails to implementing", LaneRules.Summary(Lane()));

    [Fact]
    public void Settings_read_back_from_their_own_text_change_nothing()
    {
        var stored = """{"maxSteps":60,"allowedCommands":["pnpm build"]}""";

        Assert.Equal("nothing", Sent(stored, LaneRules.SettingsText(Json(stored))));
    }

    [Fact]
    public void Only_a_changed_key_is_sent() =>
        Assert.Equal("""{"maxSteps":90}""", Sent("""{"maxSteps":60,"buildCommand":"pnpm build"}""", """{"maxSteps":90,"buildCommand":"pnpm build"}"""));

    [Fact]
    public void A_new_key_is_sent() =>
        Assert.Equal("""{"placement":"any"}""", Sent("""{"maxSteps":60}""", """{"maxSteps":60,"placement":"any"}"""));

    [Fact]
    public void A_key_gone_is_sent_as_null() =>
        Assert.Equal("""{"maxSteps":null}""", Sent("""{"maxSteps":60,"placement":"any"}""", """{"placement":"any"}"""));

    [Fact]
    public void A_null_removes_a_stored_key_and_means_nothing_for_any_other()
    {
        Assert.Equal("""{"maxSteps":null}""", Sent("""{"maxSteps":60}""", """{"maxSteps":null}"""));
        Assert.Equal("nothing", Sent("{}", """{"maxSteps":null}"""));
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData(null)]
    public void An_empty_box_removes_every_key(string? draft) =>
        Assert.Equal("""{"maxSteps":null}""", Sent("""{"maxSteps":60}""", draft));

    [Fact]
    public void Key_order_is_not_a_change() =>
        Assert.Equal("nothing", Sent("""{"a":1,"b":2}""", """{"b":2,"a":1}"""));

    [Theory]
    [InlineData("{not json", "Not valid JSON")]
    [InlineData("[1]", "must be a JSON object")]
    [InlineData("60", "must be a JSON object")]
    public void A_box_that_cannot_be_read_says_so_and_sends_nothing(string draft, string problem)
    {
        var read = LaneRules.ReadSettings(Json("{}"), draft);

        Assert.Null(read.Patch);
        Assert.Contains(problem, read.Problem);
    }

    [Fact]
    public void Nothing_changed_is_no_request() =>
        Assert.Null(LaneRules.Patch(Lane(), "Do it.", null));

    [Fact]
    public void A_request_holds_only_what_changed()
    {
        var instructions = LaneRules.Patch(Lane(), "Do it well.", null);
        Assert.Equal("Do it well.", instructions?.Instructions);
        Assert.Null(instructions?.Settings);

        var settings = LaneRules.Patch(Lane(), "Do it.", Json("""{"maxSteps":90}"""));
        Assert.Null(settings?.Instructions);
        Assert.NotNull(settings?.Settings);
    }

    [Fact]
    public void Emptied_instructions_are_sent_as_empty()
    {
        Assert.Equal(string.Empty, LaneRules.Patch(Lane(), string.Empty, null)?.Instructions);
        Assert.Equal(string.Empty, LaneRules.Patch(Lane(), null, null)?.Instructions);
    }
}
