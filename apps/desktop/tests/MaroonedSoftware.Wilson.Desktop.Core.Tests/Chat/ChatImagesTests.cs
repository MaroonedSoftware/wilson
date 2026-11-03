using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class ChatImagesTests
{
    [Theory]
    [InlineData(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1 }, "image/png")]
    [InlineData(new byte[] { 0xff, 0xd8, 0xff, 0xe0 }, "image/jpeg")]
    [InlineData(new byte[] { 0x47, 0x49, 0x46, 0x38, 0x39, 0x61 }, "image/gif")]
    [InlineData(new byte[] { 0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50 }, "image/webp")]
    public void Knows_the_four_types_by_their_first_bytes(byte[] bytes, string type) => Assert.Equal(type, ChatImages.TypeOf(bytes));

    [Theory]
    [InlineData(new byte[] { })]
    [InlineData(new byte[] { 0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45 })]
    [InlineData(new byte[] { 0x52, 0x49, 0x46, 0x46 })]
    [InlineData(new byte[] { 0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63 })]
    [InlineData(new byte[] { 0x3c, 0x73, 0x76, 0x67, 0x3e })]
    public void Refuses_anything_else(byte[] bytes) => Assert.Null(ChatImages.TypeOf(bytes));

    [Theory]
    [InlineData(ChatImages.MaxBytes, ChatImages.MaxEdge, ChatImages.MaxEdge, false)]
    [InlineData(ChatImages.MaxBytes + 1, 100, 100, true)]
    [InlineData(100, ChatImages.MaxEdge + 1, 100, true)]
    [InlineData(100, 100, ChatImages.MaxEdge + 1, true)]
    public void Scales_only_what_is_over_a_limit(long bytes, int width, int height, bool scales) =>
        Assert.Equal(scales, ChatImages.NeedsScaling(bytes, width, height));

    [Fact]
    public void Fit_keeps_the_shape_and_leaves_what_already_fits()
    {
        Assert.Equal((1568, 882), ChatImages.Fit(5120, 2880, 1568));
        Assert.Equal((882, 1568), ChatImages.Fit(2880, 5120, 1568));
        Assert.Equal((100, 50), ChatImages.Fit(100, 50, 1568));
    }

    [Fact]
    public void Fit_never_reaches_zero() => Assert.Equal((1568, 1), ChatImages.Fit(100_000, 1, 1568));

    [Theory]
    [InlineData("photo.jpeg", "photo.png")]
    [InlineData("shot.png", "shot.png")]
    [InlineData("noext", "noext.png")]
    public void A_scaled_image_is_named_a_png(string filename, string expected) => Assert.Equal(expected, ChatImages.AsPng(filename));
}
