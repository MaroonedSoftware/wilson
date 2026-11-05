using MaroonedSoftware.Wilson.Desktop.Core.Apps;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Apps;

/// <summary>Whether a real WebKit does as this says is `tools/Walk -- app-probe`. This is the rule.</summary>
public class AppNavigationPolicyTests
{
    private const long Other = -1;
    private const long Link = 0;
    private const long Reload = 3;

    private static AppNavigationPolicy Running()
    {
        var policy = new AppNavigationPolicy();
        Assert.Equal(AppNavigationDecision.Allow, policy.Decide(true, "about:blank", Other));
        Assert.Equal(AppNavigationDecision.Allow, policy.Decide(false, "about:srcdoc", Other));
        return policy;
    }

    [Theory]
    [InlineData("http://example.test/?secret=1", Other)]
    [InlineData("https://example.test/", Link)]
    [InlineData("data:text/html,hi", Other)]
    [InlineData("blob:null/abc", Other)]
    [InlineData("file:///etc/passwd", Other)]
    [InlineData("wilsonprobe://x", Other)]
    [InlineData("about:srcdoc", Reload)]
    [InlineData("about:blank%23x", Link)]
    [InlineData(null, Other)]
    public void ARunningAppGoesNowhere(string? url, long type)
    {
        Assert.Equal(AppNavigationDecision.Left, Running().Decide(false, url, type));
        Assert.Equal(AppNavigationDecision.Left, Running().Decide(true, url, type));
    }

    [Theory]
    [InlineData("about:blank")]
    [InlineData("about:srcdoc")]
    public void AFrameTheAppMadeIsRefusedWithoutClosingIt(string url) =>
        Assert.Equal(AppNavigationDecision.Refuse, Running().Decide(false, url, Other));

    [Fact]
    public void TheHostPageLoadsOnce()
    {
        var policy = Running();

        Assert.Equal(AppNavigationDecision.Left, policy.Decide(true, "about:blank", Other));
    }

    [Fact]
    public void ANewWindowIsRefused() => Assert.Equal(AppNavigationDecision.Refuse, Running().Decide(null, "http://example.test/", Link));

    [Fact]
    public void TheHostPageMustBeBlank() =>
        Assert.Equal(AppNavigationDecision.Left, new AppNavigationPolicy().Decide(true, "http://example.test/", Other));

    [Fact]
    public void TheFrameCannotGoFirst() =>
        Assert.NotEqual(AppNavigationDecision.Allow, new AppNavigationPolicy().Decide(false, "about:srcdoc", Other));

    [Fact]
    public void TheHostScriptKeepsTheSandboxAndCarriesTheDocumentAsAString()
    {
        var script = AppHostPage.Script("""<script>alert("</script>')""", AppColorScheme.Dark);

        Assert.Contains("frame.setAttribute('sandbox', \"allow-scripts\")", script, StringComparison.Ordinal);
        Assert.Contains("""frame.srcdoc = "<script>alert(\"</script>')";""", script, StringComparison.Ordinal);
    }

    [Fact]
    public void AReceivedMessageCannotBreakOutOfItsString()
    {
        var call = AppHostPage.Receive("\"); evil(); (\"");

        Assert.Equal("""wilsonAppReceive("\"); evil(); (\"")""", call);
    }

    [Fact]
    public void TheHostPagesPolicyIsTheOneTheWebAppsPageIsSent() =>
        Assert.Contains("""content="frame-src 'none'" """.TrimEnd(), AppHostPage.Html, StringComparison.Ordinal);
}
