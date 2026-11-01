using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

public class UpdateCheckTests
{
    private static readonly Version Current = new(0, 2, 0);

    private static string Release(string tag, bool draft = false, bool prerelease = false, bool assets = true)
    {
        var version = tag.Replace(UpdateCheck.TagPrefix, string.Empty, StringComparison.Ordinal);
        var listed = assets
            ? $$"""[{"name":"wilson-{{version}}-osx-arm64.zip","browser_download_url":"https://example.com/z"},{"name":"wilson-{{version}}-osx-arm64.zip.sig","browser_download_url":"https://example.com/s"}]"""
            : "[]";
        return $$"""{"tag_name":"{{tag}}","draft":{{(draft ? "true" : "false")}},"prerelease":{{(prerelease ? "true" : "false")}},"html_url":"https://example.com/r","assets":{{listed}}}""";
    }

    [Fact]
    public void TheNewestWins_WhateverOrderGitHubAnswers()
    {
        var found = UpdateCheck.Newest(Current, $"[{Release("desktop-v0.3.0")},{Release("desktop-v0.10.0")},{Release("desktop-v0.4.0")}]");

        Assert.Equal(new Version(0, 10, 0), found?.Version);
        Assert.Equal("https://example.com/z", found?.Zip);
        Assert.Equal("https://example.com/s", found?.Signature);
    }

    [Theory]
    [InlineData("desktop-v0.2.0")]
    [InlineData("desktop-v0.1.9")]
    [InlineData("desktop-v0.3.0-rc.1")]
    [InlineData("v9.9.9")]
    [InlineData("desktop-v1.0")]
    [InlineData("desktop-v1.0.0.1")]
    public void WhatIsNotANewerReleaseIsNotOffered(string tag) => Assert.Null(UpdateCheck.Newest(Current, $"[{Release(tag)}]"));

    [Fact]
    public void DraftsAndPreReleasesAreNotOffered() =>
        Assert.Null(UpdateCheck.Newest(Current, $"[{Release("desktop-v0.3.0", draft: true)},{Release("desktop-v0.4.0", prerelease: true)}]"));

    [Fact]
    public void AReleaseWithoutItsFilesIsStillNews_ButCannotBeInstalled()
    {
        var found = UpdateCheck.Newest(Current, $"[{Release("desktop-v0.3.0", assets: false)}]");

        Assert.NotNull(found);
        Assert.Null(found.Zip);
        Assert.Null(found.Signature);
    }
}
