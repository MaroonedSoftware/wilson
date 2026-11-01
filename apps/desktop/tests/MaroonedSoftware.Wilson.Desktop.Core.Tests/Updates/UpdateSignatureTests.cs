using System.Security.Cryptography;
using System.Text;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

public class UpdateSignatureTests
{
    private const string Hash = "abc123";

    private static readonly Version Version = new(0, 2, 0);

    private static (string PublicKey, byte[] Signature) Signed(string message)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (key.ExportSubjectPublicKeyInfoPem(), key.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
    }

    [Fact]
    public void TheAppCarriesThePublicHalfOfTheKey_AndOnlyThat()
    {
        var key = UpdateSignature.BuiltInKey();

        Assert.NotNull(key);
        Assert.Contains("BEGIN PUBLIC KEY", key, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE", key, StringComparison.Ordinal);

        using var parsed = ECDsa.Create();
        parsed.ImportFromPem(key);
        Assert.Equal(256, parsed.KeySize);
    }

    [Fact]
    public void AGoodSignaturePasses()
    {
        var (key, signature) = Signed("wilson-update 0.2.0 abc123");

        Assert.True(UpdateSignature.IsValid(key, Version, Hash, signature));
    }

    [Fact]
    public void AChangedFileFails()
    {
        var (key, signature) = Signed(UpdateSignature.Message(Version, Hash));

        Assert.False(UpdateSignature.IsValid(key, Version, "different", signature));
    }

    [Fact]
    public void AnOldSignedZipCannotPassAsANewerVersion()
    {
        var (key, signature) = Signed(UpdateSignature.Message(new Version(0, 1, 0), Hash));

        Assert.False(UpdateSignature.IsValid(key, Version, Hash, signature));
    }

    [Fact]
    public void AnotherKeyFails()
    {
        var (_, signature) = Signed(UpdateSignature.Message(Version, Hash));
        var (other, _) = Signed("anything");

        Assert.False(UpdateSignature.IsValid(other, Version, Hash, signature));
    }

    [Fact]
    public void GarbageIsFalse_NotAnException()
    {
        var (key, _) = Signed("anything");

        Assert.False(UpdateSignature.IsValid(key, Version, Hash, [1, 2, 3]));
        Assert.False(UpdateSignature.IsValid("not a key", Version, Hash, [1, 2, 3]));
    }

    [Fact]
    public void TheHashIsTheLowercaseHexShasumPrints() =>
        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateSignature.Hash(new MemoryStream("abc"u8.ToArray())));
}
