using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Apps;

/// <summary>
/// The web app's `app.host-fixture.test.ts` reads this same file. A change to the document on either side
/// fails here or there until the two agree, which is the only thing keeping two copies of it honest.
/// </summary>
public class AppHostFixtureTests
{
    private static readonly JsonElement Fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "app-host.json"))).RootElement;

    [Fact]
    public void TheDocumentIsTheWebAppsToTheByte()
    {
        var context = Fixture.GetProperty("context");
        var grants = context.GetProperty("grants").Deserialize<List<AppGrant>>(SdkJson.Options)!;
        var scheme = context.GetProperty("colorScheme").GetString() == "dark" ? AppColorScheme.Dark : AppColorScheme.Light;

        var document = AppDocument.Build(Fixture.GetProperty("html").GetString()!, context.GetProperty("project").GetString()!, grants, scheme);

        Assert.Equal(Fixture.GetProperty("document").GetString(), document);
    }

    [Fact]
    public void ThePolicySandboxAndConnectMessageAreTheWebApps()
    {
        Assert.Equal(AppDocument.ContentSecurityPolicy, Fixture.GetProperty("contentSecurityPolicy").GetString());
        Assert.Equal(AppDocument.Sandbox, Fixture.GetProperty("sandbox").GetString());
        Assert.Equal(AppDocument.ConnectMessage, Fixture.GetProperty("connectMessage").GetString());
    }

    [Fact]
    public void TheMethodsAreTheWebApps()
    {
        var names = Fixture.GetProperty("methods").EnumerateArray().Select(method => method.GetProperty("name").GetString()!);

        Assert.Equal(names, AppDocument.MethodNames);
    }

    [Fact]
    public void AGrantThisBuildDoesNotKnowIsLeftOut()
    {
        var document = AppDocument.Build("<p>", "demo", [AppGrant.BoardRead, AppGrant.Unknown], AppColorScheme.Light);

        Assert.Contains("""grants: Object.freeze(["board.read"])""", document, StringComparison.Ordinal);
    }

    [Fact]
    public void AProjectNameCannotEndTheScriptElement()
    {
        var document = AppDocument.Build("<p>", "</script><img src=x>", [], AppColorScheme.Light);

        Assert.DoesNotContain("</script><img", document, StringComparison.Ordinal);
    }
}
