using System.Net;
using System.Security.Cryptography;
using System.Text;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

public sealed class UpdateDownloaderTests : IDisposable
{
    private static readonly Version Version = new(0, 2, 0);

    private readonly string _directory = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    private byte[] Sign(string content, Version version) =>
        _key.SignData(
            Encoding.UTF8.GetBytes(UpdateSignature.Message(version, UpdateSignature.Hash(new MemoryStream(Encoding.UTF8.GetBytes(content))))),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);

    private Task<string?> Download(string zip, byte[] signature, string url = "https://example.com/z")
    {
        var server = new FakeServer((request, _) => request.RequestUri!.AbsolutePath == "/s"
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(signature) }
            : FakeServer.Json(HttpStatusCode.OK, zip));
        var http = new HttpClient(server);
        return new UpdateDownloader(http, _key.ExportSubjectPublicKeyInfoPem(), _directory)
            .DownloadAsync(new UpdateAvailable(Version, "https://example.com/r", url, "https://example.com/s"), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AGoodDownloadIsKept()
    {
        var path = await Download("the release", Sign("the release", Version));

        Assert.Equal("the release", await File.ReadAllTextAsync(path!, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ATamperedDownloadIsDeleted()
    {
        Assert.Null(await Download("something else", Sign("the release", Version)));
        Assert.Empty(Directory.GetFiles(_directory));
    }

    [Fact]
    public async Task AnOlderSignedReleaseUnderANewerTagIsRefused() =>
        Assert.Null(await Download("the release", Sign("the release", new Version(0, 1, 0))));

    [Fact]
    public async Task PlainHttpIsNeverFetched() =>
        Assert.Null(await Download("the release", Sign("the release", Version), "http://example.com/z"));

    [Fact]
    public async Task AReleaseWithoutItsFilesAnswersNothing()
    {
        var downloader = new UpdateDownloader(new HttpClient(new FakeServer((_, _) => throw new InvalidOperationException("no request is expected"))), "key", _directory);

        Assert.Null(await downloader.DownloadAsync(new UpdateAvailable(Version, "https://example.com/r", null, null), TestContext.Current.CancellationToken));
    }

    public void Dispose()
    {
        _key.Dispose();
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }
}
