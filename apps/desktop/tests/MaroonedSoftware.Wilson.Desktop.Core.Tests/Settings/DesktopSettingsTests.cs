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
    public void AFileThatCannotBeReadIsAFirstRun()
    {
        var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Assert.Null(DesktopSettings.Load(path).Origin);

        File.WriteAllText(path, "{ not json");
        Assert.Null(DesktopSettings.Load(path).Origin);
    }
}
