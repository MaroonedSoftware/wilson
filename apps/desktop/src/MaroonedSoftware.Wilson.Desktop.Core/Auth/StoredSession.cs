using System.Text.Json.Serialization;

namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>A signed-in operator, keyed by the server's origin because a token means nothing anywhere else.</summary>
public sealed record StoredSession
{
    [JsonPropertyName("origin")]
    public required string Origin { get; init; }

    [JsonPropertyName("email")]
    public required string Email { get; init; }

    [JsonPropertyName("accessToken")]
    public required string AccessToken { get; init; }

    /// <summary>Single-use and rotating: presenting a spent one revokes the whole family.</summary>
    [JsonPropertyName("refreshToken")]
    public required string RefreshToken { get; init; }
}
