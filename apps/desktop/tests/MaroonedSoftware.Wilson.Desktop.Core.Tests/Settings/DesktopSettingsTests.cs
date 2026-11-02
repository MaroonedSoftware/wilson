using MaroonedSoftware.Wilson.Desktop.Core.Settings;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Settings;

public class DesktopSettingsTests
{
    [Fact]
    public void RoundTrips()
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName(), "settings.json");

        new DesktopSettings { Origin = "http://tower:13101", Project = "wilson" }.Save(path);

        Assert.Equal("wilson", DesktopSettings.Load(path).Project);
    }

    [Fact]
    public void AppearanceRoundTripsByName()
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName(), "settings.json");

        new DesktopSettings { Appearance = Appearance.Dark }.Save(path);

        Assert.Contains("\"Dark\"", File.ReadAllText(path));
        Assert.Equal(Appearance.Dark, DesktopSettings.Load(path).Appearance);
    }

    [Fact]
    public void AFileFromBeforeAppearanceFollowsTheSystem()
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        File.WriteAllText(path, """{"Origin":"http://tower:13101"}""");

        Assert.Equal(Appearance.System, DesktopSettings.Load(path).Appearance);
    }

    [Theory]
    [InlineData(Appearance.System, Appearance.Light)]
    [InlineData(Appearance.Light, Appearance.Dark)]
    [InlineData(Appearance.Dark, Appearance.System)]
    public void AppearanceStepsThroughAllThree(Appearance from, Appearance to) => Assert.Equal(to, Appearances.Next(from));

    [Fact]
    public void AFileThatCannotBeReadIsAFirstRun()
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Assert.Null(DesktopSettings.Load(path).Origin);

        File.WriteAllText(path, "{ not json");
        Assert.Null(DesktopSettings.Load(path).Origin);
    }
}
