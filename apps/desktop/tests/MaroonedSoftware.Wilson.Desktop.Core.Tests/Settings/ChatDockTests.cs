using MaroonedSoftware.Wilson.Desktop.Core.Settings;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Settings;

public class ChatDockTests
{
    [Fact]
    public void StartsClosedOnTheRight()
    {
        var dock = new ChatDock();

        Assert.False(dock.Open);
        Assert.Equal(ChatDockPosition.Right, dock.Position);
        Assert.Equal((420, 320), (dock.Width, dock.Height));
    }

    [Theory]
    [InlineData(10, 10, 320, 200)]
    [InlineData(5000, 5000, 720, 640)]
    [InlineData(500, 300, 500, 300)]
    public void IsHeldWithinItsLimits(int width, int height, int heldWidth, int heldHeight)
    {
        var held = new ChatDock { Width = width, Height = height }.Held();

        Assert.Equal((heldWidth, heldHeight), (held.Width, held.Height));
    }

    [Fact]
    public void ComesBackTheWayItWasLeft()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.json");
        try
        {
            var dock = new ChatDock { Open = true, Position = ChatDockPosition.Bottom, Height = 400 };
            new DesktopSettings { Dock = dock }.Save(path);

            Assert.Equal(dock, DesktopSettings.Load(path).Dock);
            Assert.Contains("\"Bottom\"", File.ReadAllText(path), StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void AnOlderFileHasItClosed()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.json");
        try
        {
            File.WriteAllText(path, """{"Origin":"http://tower"}""");

            Assert.False(DesktopSettings.Load(path).Dock.Open);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
