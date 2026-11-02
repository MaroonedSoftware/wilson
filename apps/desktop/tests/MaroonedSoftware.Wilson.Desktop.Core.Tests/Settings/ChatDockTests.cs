using MaroonedSoftware.Wilson.Desktop.Core.Settings;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Settings;

public class ChatDockTests
{
    [Fact]
    public void StartsOpenOnTheRight()
    {
        var dock = new ChatDock();

        Assert.True(dock.Open);
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
            var dock = new ChatDock { Closed = true, Position = ChatDockPosition.Bottom, Height = 400 };
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
    public void StaysClosedOnceClosed()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.json");
        try
        {
            new DesktopSettings { Dock = new ChatDock { Closed = true } }.Save(path);

            Assert.False(DesktopSettings.Load(path).Dock.Open);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("""{"Origin":"http://tower"}""")]
    [InlineData("""{"Dock":{"Open":false,"Position":"Bottom","Width":500,"Height":300}}""")]
    public void AnOlderFileHasItOpen(string older)
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.json");
        try
        {
            File.WriteAllText(path, older);

            Assert.True(DesktopSettings.Load(path).Dock.Open);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
