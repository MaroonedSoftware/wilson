using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>Whether a download really is the release it claims to be.</summary>
/// <remarks>
/// The app is not notarised, so nothing else vouches for an update, and the app holds the operator's
/// session. The release workflow signs this message with a key kept as a repository secret. It names
/// the version as well as the file's hash, so an old signed zip cannot be attached to a newer tag to
/// bring back a bug. ECDSA P-256, because it is in both .NET and openssl and needs no package.
/// </remarks>
public static class UpdateSignature
{
    private const string KeyResource = "update-key.pem";

    /// <summary>The key built into this app, or null in a build made without one, which can only give notice.</summary>
    public static string? BuiltInKey()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(KeyResource);
        if (stream is null)
        {
            return null;
        }

        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>What is signed. `.github/workflows/desktop-release.yml` must build exactly this.</summary>
    public static string Message(Version version, string sha256) => $"wilson-update {version} {sha256}";

    public static string Hash(Stream content) => Convert.ToHexStringLower(SHA256.HashData(content));

    /// <summary>True only for a signature by the key over this version and hash. Anything malformed is simply false.</summary>
    public static bool IsValid(string publicKey, Version version, string sha256, byte[] signature)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportFromPem(publicKey);
            return key.VerifyData(Encoding.UTF8.GetBytes(Message(version, sha256)), signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        catch (Exception failure) when (failure is CryptographicException or ArgumentException)
        {
            return false;
        }
    }
}
