using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Net;

public class ServerAddressTests
{
    [Theory]
    [InlineData("wilson.example.com", "https://wilson.example.com")]
    [InlineData("  https://wilson.example.com/  ", "https://wilson.example.com")]
    [InlineData("https://wilson.example.com/projects/a?x=1", "https://wilson.example.com")]
    [InlineData("192.168.1.20:13100", "http://192.168.1.20:13100")]
    [InlineData("tower:13101", "http://tower:13101")]
    [InlineData("http://TOWER:13101/", "http://tower:13101")]
    [InlineData("192. 168.1.20 : 13100", "http://192.168.1.20:13100")]
    public void ReadsAnAddress(string text, string origin) => Assert.Equal(origin, ServerAddress.Parse(text));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("http:/tower")]
    [InlineData("ftp://tower")]
    [InlineData("two words")]
    [InlineData("https://user:secret@wilson.example.com")]
    public void RefusesWhatIsNotAnAddress(string text) => Assert.Null(ServerAddress.Parse(text));
}
