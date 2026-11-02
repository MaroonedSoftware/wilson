using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Auth;

public sealed class DataUrlTests
{
    [Fact]
    public void Reads_the_bytes_of_a_base64_url() =>
        Assert.Equal([1, 2, 3], DataUrl.Bytes("data:image/png;base64,AQID"));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("https://example.com/a.png")]
    [InlineData("data:image/svg+xml,<svg/>")]
    [InlineData("data:image/png;base64,***")]
    public void Anything_else_is_nothing(string? url) =>
        Assert.Null(DataUrl.Bytes(url));
}
