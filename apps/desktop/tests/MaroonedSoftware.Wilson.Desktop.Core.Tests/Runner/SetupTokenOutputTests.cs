using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Runner;

public sealed class SetupTokenOutputTests
{
    private const string MadeUp = "sk-ant-at01-wAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";

    /// <summary>The shape measured on Claude Code 2.1.317, with made-up values: cursor moves for spaces, and escapes around it.</summary>
    private static string Printed(string token) =>
        "\u001b7\u001b8\u001b[>0q\rBrowser\u001b[1Cdidn't\u001b[1Copen?\r\r\n\r\r\n"
        + "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz\r\r\n\r\r\n"
        + "\r\r\u001b[32m✓\u001b[39m\u001b[1CLong-lived\u001b[1Ctoken\u001b[1Ccreated!\r\r"
        + $"Your\u001b[1COAuth\u001b[1Ctoken:\r{token}\r\r\n\r\r\n"
        + "Use\u001b[1Cthis\u001b[1Ctoken\u001b[1Cby\u001b[1Csetting:\u001b[1Cexport\u001b[1CCLAUDE_CODE_OAUTH_TOKEN=<token>\r\r\n"
        + "\u001b[>4m\u001b[<u\u001b(B\u000f\u001b7\u001b8";

    [Fact]
    public void A_token_is_found_among_the_escapes() => Assert.Equal(MadeUp, SetupTokenOutput.Token(Printed(MadeUp)));

    [Fact]
    public void A_token_printed_twice_is_still_one_token() => Assert.Equal(MadeUp, SetupTokenOutput.Token(Printed(MadeUp) + Printed(MadeUp)));

    [Fact]
    public void Two_different_tokens_are_refused_rather_than_guessed_between() =>
        Assert.Null(SetupTokenOutput.Token(Printed(MadeUp) + Printed(MadeUp.Replace('w', 'x'))));

    [Fact]
    public void A_token_cut_short_is_refused() => Assert.Null(SetupTokenOutput.Token(Printed("sk-ant-at01-short")));

    [Fact]
    public void Output_before_authorizing_has_no_token() =>
        Assert.Null(SetupTokenOutput.Token("Browser didn't open? https://claude.com/cai/oauth/authorize?code=true"));

    [Fact]
    public void Another_prefix_generation_is_still_a_token() =>
        Assert.Equal(MadeUp.Replace("at01", "oat02"), SetupTokenOutput.Token(Printed(MadeUp.Replace("at01", "oat02"))));

    [Fact]
    public void The_link_is_found_whole() =>
        Assert.Equal("https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz", SetupTokenOutput.SignInLink(Printed(MadeUp)));

    [Fact]
    public void Output_with_no_link_has_none() => Assert.Null(SetupTokenOutput.SignInLink("Welcome to Claude Code https://claude.com/docs"));

    [Fact]
    public void A_result_never_prints_its_token() => Assert.DoesNotContain(MadeUp, ClaudeSignInResult.Succeeded(MadeUp).ToString());

    [Theory]
    [InlineData(ClaudeSignInFailure.NotFound, "Couldn't find")]
    [InlineData(ClaudeSignInFailure.NoToken, "no token")]
    [InlineData(ClaudeSignInFailure.TimedOut, "in time")]
    public void Every_failure_says_how_to_paste_instead(ClaudeSignInFailure failure, string words)
    {
        var advice = ClaudeSignInResult.Failed(failure).Advice;
        Assert.Contains(words, advice);
        Assert.Contains("paste the token", advice);
    }
}
